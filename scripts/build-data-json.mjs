// scripts/build-data-json.mjs
// Scans DATA/ for data_*.txt result files, decodes the XOR+Base64
// "encrypted" main files, merges in per-subject marks from the
// matching _individual.txt files where present, and writes:
//
//   DATA/all-data.json   — one flat array of every student record
//   DATA/index.json      — a small manifest of what datasets exist
//
// File naming this expects (same as the live site):
//   HSC:  data_hsc_{year}_{group}.txt          e.g. data_hsc_2023_arts.txt
//   SSC:  data_{year}_{group}.txt              e.g. data_2022_science.txt
//   individual variants add "_individual" before .txt

import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'DATA');
const XOR_KEY = 'MySecretKey123';

const FILE_RE = /^data_(hsc_)?(\d{4})_(science|arts|commerce)(_individual)?\.txt$/i;

function xorDecrypt(buf, key) {
  const keyBuf = Buffer.from(key, 'utf8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ keyBuf[i % keyBuf.length];
  }
  return out;
}

function decodeMain(rawText) {
  const decoded = Buffer.from(rawText.trim(), 'base64');
  const original = xorDecrypt(decoded, XOR_KEY);
  return original.toString('utf8');
}

function parseMainRows(text, meta) {
  // The source files duplicate their first data line as a throwaway
  // "header" row — same quirk the original site's own parser works
  // around, so we drop it here too.
  const lines = text.trim().split('\n').slice(1);
  const rows = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const [, name, roll, gpa, total, institution] = line.split('\t');
    if (!roll || !name) continue;
    rows.push({
      exam: meta.exam,
      year: meta.year,
      group: meta.group,
      roll: roll.trim(),
      name: name.trim(),
      institution: (institution || '').trim(),
      gpa: (gpa || '').trim(),
      total: (total || '').trim(),
    });
  }
  return rows;
}

function parseIndividualRows(text) {
  const map = {};
  const lines = text.trim().split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const cols = line.split('\t');
    const roll = (cols[0] || '').trim();
    if (!roll) continue;
    map[roll] = cols.slice(1).map((v) => {
      const n = parseInt(v, 10);
      return Number.isNaN(n) ? null : n;
    });
  }
  return map;
}

async function main() {
  const files = await fs.readdir(DATA_DIR);

  // Pair up each main file with its _individual counterpart, if any.
  const groups = new Map();
  for (const file of files) {
    const m = file.match(FILE_RE);
    if (!m) continue;
    const exam = m[1] ? 'hsc' : 'ssc';
    const year = m[2];
    const group = m[3].toLowerCase();
    const isIndividual = !!m[4];
    const key = `${exam}_${year}_${group}`;
    const entry = groups.get(key) || { exam, year, group };
    if (isIndividual) entry.individualFile = file;
    else entry.mainFile = file;
    groups.set(key, entry);
  }

  const allRecords = [];
  const manifest = [];

  for (const [key, entry] of groups) {
    if (!entry.mainFile) {
      console.warn(`Skipping ${key}: no main file found (only an _individual file exists)`);
      continue;
    }

    const mainRaw = await fs.readFile(path.join(DATA_DIR, entry.mainFile), 'utf8');
    const mainText = decodeMain(mainRaw);
    const rows = parseMainRows(mainText, entry);

    if (entry.individualFile) {
      const indRaw = await fs.readFile(path.join(DATA_DIR, entry.individualFile), 'utf8');
      const individualMap = parseIndividualRows(indRaw);
      for (const row of rows) {
        const marks = individualMap[row.roll];
        if (marks) row.subjects = marks;
      }
    }

    allRecords.push(...rows);
    manifest.push({ exam: entry.exam, year: entry.year, group: entry.group, count: rows.length });
    console.log(`Parsed ${key}: ${rows.length} records`);
  }

  await fs.writeFile(path.join(DATA_DIR, 'all-data.json'), JSON.stringify(allRecords));

  await fs.writeFile(
    path.join(DATA_DIR, 'index.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), datasets: manifest }, null, 2)
  );

  console.log(`Done. Total records: ${allRecords.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
