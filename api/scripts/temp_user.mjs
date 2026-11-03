// Temporary STAFF/OWNER user for device or API smoke tests.
//
//   node scripts/temp_user.mjs create <username> <password> [role] [locationCode]
//   node scripts/temp_user.mjs delete <username>
//
// ALWAYS delete the user when the test is done — a live credential left in
// production is a security hole.
import "dotenv/config";
import bcrypt from "bcryptjs";
import { db } from "../src/firestore.js";

const [cmd, username, password, role = "STAFF", locationCode] = process.argv.slice(2);

async function main() {
  if (!cmd || !username) {
    console.log("usage: node scripts/temp_user.mjs create <username> <password> [role] [locationCode]");
    console.log("       node scripts/temp_user.mjs delete <username>");
    process.exitCode = 1;
    return;
  }
  const existing = await db.users.findUnique({ where: { username } });

  if (cmd === "delete") {
    if (!existing) {
      console.log(`no user "${username}" (already removed?)`);
      return;
    }
    await db.users.delete({ where: { id: existing.id } });
    const gone = await db.users.findUnique({ where: { username } });
    console.log(gone ? `!! "${username}" still present` : `deleted "${username}"`);
    return;
  }

  if (cmd === "create") {
    if (!password) {
      console.log("password required");
      process.exitCode = 1;
      return;
    }
    let locationId = null;
    if (locationCode) {
      const loc = await db.location.findUnique({ where: { code: locationCode } });
      if (!loc) {
        console.log(`location "${locationCode}" not found`);
        process.exitCode = 1;
        return;
      }
      locationId = loc.id;
    }
    const data = {
      name: `Temp ${username}`,
      username,
      passwordHash: await bcrypt.hash(password, 10),
      role,
      active: true,
      locationId,
      email: null,
      rfidUid: null,
    };
    if (existing) {
      await db.users.update({ where: { id: existing.id }, data });
      console.log(`updated "${username}" (id ${existing.id}, ${role}${locationCode ? ` @ ${locationCode}` : ""})`);
    } else {
      const created = await db.users.create({ data });
      console.log(`created "${username}" (id ${created.id}, ${role}${locationCode ? ` @ ${locationCode}` : ""})`);
    }
    return;
  }

  console.log(`unknown command "${cmd}"`);
  process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
