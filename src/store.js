const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_STORE = {
  blockedUsers: {}
};

function getDataFilePath() {
  const configuredPath = process.env.DATA_FILE;
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.resolve(process.cwd(), 'data', 'blocked-users.json');
}

async function ensureStoreFile() {
  const filePath = getDataFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify(DEFAULT_STORE, null, 2), 'utf8');
  }

  return filePath;
}

async function readStore() {
  const filePath = await ensureStoreFile();
  const raw = await fs.readFile(filePath, 'utf8');

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.blockedUsers !== 'object') {
      return { ...DEFAULT_STORE };
    }

    return parsed;
  } catch {
    return { ...DEFAULT_STORE };
  }
}

async function writeStore(store) {
  const filePath = await ensureStoreFile();
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf8');
}

async function upsertBlockedUser(userId, payload) {
  const store = await readStore();
  store.blockedUsers[userId] = payload;
  await writeStore(store);
}

async function removeBlockedUser(userId) {
  const store = await readStore();
  const existing = store.blockedUsers[userId];
  if (!existing) {
    return false;
  }

  delete store.blockedUsers[userId];
  await writeStore(store);
  return true;
}

async function getBlockedUser(userId) {
  const store = await readStore();
  return store.blockedUsers[userId] ?? null;
}

module.exports = {
  getBlockedUser,
  removeBlockedUser,
  upsertBlockedUser
};
