// Who is this Google identity? Match by Google's id first, then by email; otherwise create the account.
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users, emailVerifications, passwordResets } from '../db/schema';
import type { GoogleIdentity } from './google-auth';

type User = typeof users.$inferSelect;
export type GoogleOutcome =
  | 'existing_google'          // already linked: plain login
  | 'linked'                   // an existing, email-verified account was linked to this Google account
  | 'linked_reset_password'    // an existing UNVERIFIED account was linked: its password was thrown away (see below)
  | 'created';                 // brand-new account

export class GoogleEmailNotVerified extends Error {}
export class GoogleAccountConflict extends Error {}

const unusableHash = () => bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

/**
 * Rules:
 *  - Google must vouch for the email (email_verified), otherwise nothing is created or linked.
 *  - Same Google id -> same account (even if the person later changes their Google email).
 *  - Same email as an existing account -> that account is linked, so there is one person = one account.
 *      * If the old account's email was already verified, its password keeps working.
 *      * If it was NOT verified, whoever registered it never proved they own that address (this is what the
 *        sign-up bots do with other people's emails). Google just proved the real owner is here, so the old
 *        password is discarded and pending verification/reset links are cancelled: the real owner takes over,
 *        the squatter is locked out.
 *  - New email -> new account, already verified (no verification email is sent), without a usable password.
 */
export async function resolveGoogleUser(identity: GoogleIdentity): Promise<{ user: User; outcome: GoogleOutcome }> {
  if (!identity.emailVerified) throw new GoogleEmailNotVerified();
  const email = identity.email.trim().toLowerCase();

  const [bySub] = await db.select().from(users).where(eq(users.googleSub, identity.sub)).limit(1);
  if (bySub) return { user: bySub, outcome: 'existing_google' };

  const [byEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (byEmail) {
    if (byEmail.googleSub && byEmail.googleSub !== identity.sub) throw new GoogleAccountConflict();
    if (byEmail.emailVerified) {
      const [u] = await db.update(users).set({ googleSub: identity.sub }).where(eq(users.id, byEmail.id)).returning();
      return { user: u, outcome: 'linked' };
    }
    const passwordHash = await unusableHash();
    const [u] = await db.update(users)
      .set({ googleSub: identity.sub, emailVerified: true, passwordHash, passwordSet: false })
      .where(eq(users.id, byEmail.id)).returning();
    await db.delete(emailVerifications).where(eq(emailVerifications.userId, byEmail.id));
    await db.delete(passwordResets).where(eq(passwordResets.userId, byEmail.id));
    return { user: u, outcome: 'linked_reset_password' };
  }

  try {
    const [u] = await db.insert(users)
      .values({ email, passwordHash: await unusableHash(), passwordSet: false, emailVerified: true, googleSub: identity.sub })
      .returning();
    return { user: u, outcome: 'created' };
  } catch (err) {
    // Two requests of the same person racing: the unique index on email/google_sub made one lose; take the winner.
    const [again] = await db.select().from(users).where(and(eq(users.email, email))).limit(1);
    if (again) return { user: again, outcome: again.googleSub === identity.sub ? 'existing_google' : 'linked' };
    throw err;
  }
}
