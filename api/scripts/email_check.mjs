// Safe, one-command check of the password-OTP email path.
//
//   npm run email:check
//   npm run email:check -- --send you@example.com
//
// Without --send it only reports the selected provider and whether the Gmail
// token exchange works. It never prints a client secret or refresh token.
// With --send it sends a real test code (or prints it when EMAIL_PROVIDER is
// console). Use a real inbox you can open before testing password recovery.
import "dotenv/config";
import { emailStatus, sendOtpEmail } from "../src/services/gmail.js";
import {
  OTP_PURPOSE_CHANGE,
  isPlaceholderEmail,
  validEmail,
} from "../src/services/password_reset.js";

const args = process.argv.slice(2);
const sendIndex = args.indexOf("--send");
const recipient = sendIndex >= 0 ? args[sendIndex + 1] : null;

const status = await emailStatus();
console.log("Email OTP status:");
console.log(JSON.stringify(status, null, 2));

if (sendIndex >= 0) {
  if (!recipient || !validEmail(recipient) || isPlaceholderEmail(recipient)) {
    console.error(
      "\nUsage: npm run email:check -- --send you@example.com\n" +
        "Refusing to send without a real recipient address.",
    );
    process.exit(1);
  }
  try {
    const result = await sendOtpEmail({
      to: recipient.trim().toLowerCase(),
      code: "482916",
      purpose: OTP_PURPOSE_CHANGE,
    });
    console.log("\nTest delivery result:", result);
    console.log(
      result.sent
        ? "Check that inbox for the CartIQ password change code."
        : "The code was handled by the local console provider (see above).",
    );
  } catch (err) {
    console.error("\nTest delivery failed:", String(err?.message ?? err));
    process.exitCode = 1;
  }
}
