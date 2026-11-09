import {gzipSync,gunzipSync} from 'node:zlib';

// Storage readings are persisted separately from accounts/jobs. Keep only their
// timestamps in memory; ordinary writes never copy or serialize the readings.
export function openStorage(service){
  service.db.exec('CREATE TABLE IF NOT EXISTS portal_storage (machine TEXT PRIMARY KEY, data BLOB NOT NULL, checked_at TEXT, scanned_at TEXT)');
  service.storageSnapshots=Object.fromEntries(service.db.prepare('SELECT machine,checked_at,scanned_at FROM portal_storage').all()
    .map(row=>[row.machine,{checkedAt:row.checked_at,scannedAt:row.scanned_at}]));
}

export function writeStorage(service,machine,row){
  const data=gzipSync(JSON.stringify(row));
  service.db.prepare('INSERT INTO portal_storage(machine,data,checked_at,scanned_at) VALUES(?,?,?,?) ON CONFLICT(machine) DO UPDATE SET data=excluded.data,checked_at=excluded.checked_at,scanned_at=excluded.scanned_at')
    .run(machine,data,row.checkedAt??null,row.scannedAt??null);
  service.storageSnapshots[machine]={checkedAt:row.checkedAt??null,scannedAt:row.scannedAt??null};
}

export function readStorage(service,machine){
  const row=service.db.prepare('SELECT data FROM portal_storage WHERE machine=?').get(machine);
  return row?{...JSON.parse(gunzipSync(row.data).toString('utf8')),...service.storageSnapshots[machine]}:{};
}

// A rolled-back release may leave inline failures next to good stored readings.
// Merge those failures as refresh does, without replacing newer samples.
export function mergeStorage(stored,incoming){
  if(Date.parse(incoming.checkedAt)<Date.parse(stored.checkedAt))return stored;
  const merged={...stored,...incoming,checkedAt:incoming.checkedAt??stored.checkedAt};
  for(const part of ['quota','datasets','projects']){
    const value=incoming[part],previous=stored[part];
    if(Date.parse(value?.checkedAt)<Date.parse(previous?.checkedAt))merged[part]=previous;
    else if(value?.error)merged[part]={...previous,...value,checkedAt:value.checkedAt??previous?.checkedAt};
  }
  return merged;
}

export function saveStorageTimes(service){
  const update=service.db.prepare('UPDATE portal_storage SET checked_at=?,scanned_at=? WHERE machine=?');
  for(const [machine,row] of Object.entries(service.storageSnapshots))update.run(row.checkedAt??null,row.scannedAt??null,machine);
}
