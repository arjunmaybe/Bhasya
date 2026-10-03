import { openDb, seedDev } from '@bhasya/db';

const db = await openDb();
const s = await seedDev(db);
console.log(JSON.stringify(s));
await db.close?.();
