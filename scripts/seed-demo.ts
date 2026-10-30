// Create or reset the demo workspace (Snap & Smile Photobooth + Rempah Kitchen).
//   DEMO_PASSWORD=... npm run seed:demo
// Safe to run again: it replaces the demo accounts, never duplicates them.
import { seedDemo, DEMO_EMAIL } from "../src/lib/demo.ts";

try {
  const r = await seedDemo();
  console.log(`Demo ready: ${r.enquiries} enquiries, ${r.bookedSaturday} fully booked. Log in at /login as ${DEMO_EMAIL} with DEMO_PASSWORD.`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
