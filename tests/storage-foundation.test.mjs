import assert from "node:assert/strict";
import test from "node:test";
import {
  DATABASE_NAME,
  LOCAL_SCHEMA_VERSION,
  META_STORE,
  STORE_DEFINITIONS,
  applySchemaUpgrade,
  createLocalId,
  getLocalStoreHealth,
  normalizeText,
  openTeacherWorkspaceDb,
  prepareRecord
} from "../dist/storage.js";

class FakeStore {
  constructor(name) { this.name = name; this.indexes = []; this.records = []; this.indexNames = { contains: (value) => this.indexes.some((index) => index.name === value) }; }
  createIndex(name, keyPath, options) { this.indexes.push({ name, keyPath, options }); }
  put(record) { this.records.push(record); }
}

class FakeDatabase {
  constructor() {
    this.version = LOCAL_SCHEMA_VERSION;
    this.stores = new Map();
    this.objectStoreNames = { contains: (name) => this.stores.has(name) };
  }
  createObjectStore(name) { const store = new FakeStore(name); this.stores.set(name, store); return store; }
  transaction(name) {
    return {
      objectStore: () => ({
        get: (key) => {
          const request = {};
          queueMicrotask(() => {
            request.result = this.stores.get(name).records.find((record) => record.key === key);
            request.onsuccess?.();
          });
          return request;
        }
      })
    };
  }
  close() { this.closed = true; }
}

class FakeIndexedDb {
  constructor() { this.database = new FakeDatabase(); }
  open() {
    const request = {
      result: this.database,
      oldVersion: 0,
      transaction: { objectStore: (name) => this.database.stores.get(name) }
    };
    queueMicrotask(() => {
      request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  }
}

test("the current schema creates the complete shared local data model", () => {
  const database = new FakeDatabase();
  const transaction = { objectStore: (name) => database.stores.get(name) };
  applySchemaUpgrade(database, 0, transaction);
  assert.equal(DATABASE_NAME, "teacher-workspace");
  assert.equal(database.stores.has("meta"), true);
  for (const definition of STORE_DEFINITIONS) {
    assert.equal(database.stores.has(definition.name), true, `${definition.name} should exist`);
    assert.deepEqual(database.stores.get(definition.name).indexes.map(({ name }) => name), definition.indexes.map(([name]) => name));
  }
  assert.equal(database.stores.get("meta").records[0].value, LOCAL_SCHEMA_VERSION);
});

test("upgrade remains additive when the base model already exists", () => {
  const database = new FakeDatabase();
  const transaction = { objectStore: (name) => database.stores.get(name) };
  applySchemaUpgrade(database, 0, transaction);
  const before = database.stores.size;
  applySchemaUpgrade(database, 1, transaction);
  assert.equal(database.stores.size, before);
  assert.equal(database.stores.get("meta").records.length, 2);
});

test("schema v6 upgrades add My Materials without replacing existing class stores or records", () => {
  const database = new FakeDatabase(); database.version = 6;
  database.createObjectStore(META_STORE, { keyPath: "key" });
  for (const definition of STORE_DEFINITIONS.filter(({ name }) => name !== "materials")) {
    const store = database.createObjectStore(definition.name, { keyPath: "id" });
    for (const [name, keyPath] of definition.indexes) store.createIndex(name, keyPath, { unique: false });
  }
  const savedClass = { id: "class-preserved", className: "Grade 5" }; database.stores.get("classes").put(savedClass);
  const transaction = { objectStore: (name) => database.stores.get(name) };
  applySchemaUpgrade(database, 6, transaction);
  assert.equal(database.stores.has("materials"), true);
  assert.equal(database.stores.get("classes").records[0].id, savedClass.id);
  assert.equal(database.stores.get(META_STORE).records.at(-1).value, LOCAL_SCHEMA_VERSION);
  assert.equal(LOCAL_SCHEMA_VERSION, 7);
});

test("record preparation normalizes common fields and rejects unknown stores", () => {
  const saved = prepareRecord("classes", { id: "  Grade 7-A  ", title: "  Advisory\nClass  " }, "2026-09-28T00:00:00.000Z");
  assert.equal(saved.id, "Grade 7-A");
  assert.equal(saved.title, "  Advisory\nClass  ");
  assert.equal(saved.createdAt, "2026-09-28T00:00:00.000Z");
  assert.equal(normalizeText("  hello\n teacher "), "hello teacher");
  assert.match(createLocalId("class"), /^class_/);
  assert.throws(() => prepareRecord("unknown", {}), /not available/);
});

test("storage initialization gives a recoverable message when IndexedDB is unavailable", async () => {
  await assert.rejects(openTeacherWorkspaceDb(null), /does not support private device storage/);
});

test("storage initialization creates and reads the current schema metadata", async () => {
  const indexedDb = new FakeIndexedDb();
  const health = await getLocalStoreHealth(indexedDb);
  assert.deepEqual(health, { ready: true, schemaVersion: LOCAL_SCHEMA_VERSION, databaseVersion: LOCAL_SCHEMA_VERSION });
  assert.equal(indexedDb.database.closed, true);
});
