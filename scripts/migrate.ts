import { migrate, openDb, seedDev } from '@bhasya/db';

const db = await openDb();
await migrate(db);
const s = await seedDev(db);
console.log(`migrated + seeded user=${s.userId} workspace=${s.workspaceId}`);
await db.close?.();
