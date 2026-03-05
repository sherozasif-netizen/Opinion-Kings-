const express = require('express');
const { getDb } = require('../database');
const {
  generateCode,
  MAX_WAITLIST,
  BOOST_PER_REFERRAL,
  REWARD_MILESTONES,
  getNextReward,
} = require('../utils');

const router = express.Router();

let stmts;
function prepareStatements() {
  if (stmts) return stmts;
  const db = getDb();

  stmts = {
    countUsers: db.prepare('SELECT COUNT(*) AS cnt FROM waitlist_users'),
    findByEmail: db.prepare('SELECT * FROM waitlist_users WHERE email = ?'),
    findByPhone: db.prepare('SELECT * FROM waitlist_users WHERE phone = ?'),
    findByCode: db.prepare('SELECT * FROM waitlist_users WHERE referral_code = ?'),
    findById: db.prepare('SELECT * FROM waitlist_users WHERE id = ?'),

    insertUser: db.prepare(`
      INSERT INTO waitlist_users (full_name, email, phone, referral_code, referrer_id)
      VALUES (@full_name, @email, @phone, @referral_code, @referrer_id)
    `),

    insertReferral: db.prepare(`
      INSERT OR IGNORE INTO referrals (referrer_id, referred_user_id)
      VALUES (@referrer_id, @referred_user_id)
    `),

    bumpReferrer: db.prepare(`
      UPDATE waitlist_users
         SET referral_count = referral_count + 1,
             boost_points   = boost_points + @boost
       WHERE id = @id
    `),

    grantCredits: db.prepare(`
      UPDATE waitlist_users
         SET credits_earned = credits_earned + @credits
       WHERE id = @id
    `),

    grantVip: db.prepare(`
      UPDATE waitlist_users SET vip_badge = 1 WHERE id = @id
    `),

    hasReward: db.prepare(`
      SELECT 1 FROM reward_events WHERE user_id = @user_id AND type = @type LIMIT 1
    `),

    insertReward: db.prepare(`
      INSERT INTO reward_events (user_id, type, amount) VALUES (@user_id, @type, @amount)
    `),

    // position = how many users are ahead of you + 1 (1 = best)
    positionOf: db.prepare(`
      SELECT COUNT(*) + 1 AS pos FROM waitlist_users
       WHERE boost_points > (SELECT boost_points FROM waitlist_users WHERE id = ?)
          OR (boost_points = (SELECT boost_points FROM waitlist_users WHERE id = ?)
              AND created_at < (SELECT created_at FROM waitlist_users WHERE id = ?))
    `),

    leaderboard: db.prepare(`
      SELECT id, full_name, email, phone, boost_points, referral_count, vip_badge, created_at
        FROM waitlist_users
       ORDER BY boost_points DESC, created_at ASC
       LIMIT ?
    `),
  };
  return stmts;
}

// position 1 = best → display rank #1. position N = worst → display rank #5000
// display_rank = MAX_WAITLIST - position + 1  (so #1 in position shows as #5000... no)
// Actually: user wants "start from 5000 downward". So the LAST person = #5000, best person = #1
// But with boosts you move UP (lower number). So display_rank = position directly.
// Wait re-reading: "start from 5000 to onward" means new signups start around #5000 and climb up.
// So: display_rank = MAX_WAITLIST + 1 - position.  position 1 (best) = #5000... no that's backwards.
// 
// Let me think: 5000 spots. You join, you're near the back = #5000. You get referrals, you climb
// toward #1. So: display_rank = total_users + 1 - position? No.
// Simplest: display_rank = MAX_WAITLIST - position + 1
// If position=1 (best) → rank = 5000. If position=5000 (worst) → rank = 1. That's INVERTED.
//
// Correct: position 1 = best = should show LOW number (close to #1 = front of line).
// "start from 5000" means when you first join with 0 boosts you're ~#5000.
// So display_rank = MAX_WAITLIST - (total - position) = MAX_WAITLIST - total + position
// When total=1, position=1 → rank = 5000 - 1 + 1 = 5000 ✓ (only person, at back)
// When total=100, position=1 (best) → rank = 5000 - 100 + 1 = 4901 ✓
// When total=100, position=100 (worst) → rank = 5000 - 100 + 100 = 5000 ✓
// This works! Lower rank number = closer to front.

function computeDisplayRank(userId, totalUsers) {
  const s = prepareStatements();
  const pos = s.positionOf.get(userId, userId, userId).pos;
  return MAX_WAITLIST - totalUsers + pos;
}

function displayName(user) {
  if (user.full_name && user.full_name.trim()) {
    const parts = user.full_name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return parts[0] + ' ' + parts[parts.length - 1][0] + '.';
    }
    return parts[0];
  }
  if (user.email) {
    return user.email.split('@')[0];
  }
  return 'Anonymous';
}

function userPayload(user, displayRank, totalUsers) {
  return {
    user_id: user.id,
    full_name: user.full_name,
    email: user.email,
    referral_code: user.referral_code,
    referral_link: `${process.env.BASE_URL || 'http://localhost:3001'}/waitlist.html?ref=${user.referral_code}`,
    rank: displayRank,
    total_users: totalUsers,
    referral_count: user.referral_count,
    boost_points: user.boost_points,
    credits_earned: user.credits_earned,
    vip_badge: !!user.vip_badge,
    next_reward: getNextReward(user.referral_count),
  };
}

function processRewards(referrer) {
  const s = prepareStatements();
  for (const m of REWARD_MILESTONES) {
    if (referrer.referral_count + 1 >= m.threshold) {
      const already = s.hasReward.get({ user_id: referrer.id, type: m.type });
      if (!already) {
        s.insertReward.run({ user_id: referrer.id, type: m.type, amount: m.credits });
        if (m.credits > 0) s.grantCredits.run({ credits: m.credits, id: referrer.id });
        if (m.vip) s.grantVip.run({ id: referrer.id });
      }
    }
  }
}

// ─── POST /api/waitlist/join ─────────────────────────────────────────
router.post('/join', (req, res) => {
  const s = prepareStatements();
  const db = getDb();
  const { full_name, email, phone, referral_code } = req.body;

  if (!email && !phone) {
    return res.status(400).json({ error: 'Email or phone is required.' });
  }
  if (!full_name || !full_name.trim()) {
    return res.status(400).json({ error: 'Full name is required.' });
  }

  const cleanEmail = email ? email.trim().toLowerCase() : null;

  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Invalid email format.' });
  }

  const existing = cleanEmail ? s.findByEmail.get(cleanEmail) : s.findByPhone.get(phone);
  if (existing) {
    const totalUsers = s.countUsers.get().cnt;
    const rank = computeDisplayRank(existing.id, totalUsers);
    return res.json({ already_joined: true, ...userPayload(existing, rank, totalUsers) });
  }

  const totalUsers = s.countUsers.get().cnt;
  if (totalUsers >= MAX_WAITLIST) {
    return res.status(409).json({ error: 'Waitlist is full. Stay tuned for launch!' });
  }

  let referrer = null;
  if (referral_code) {
    referrer = s.findByCode.get(referral_code);
    if (!referrer) {
      return res.status(400).json({ error: 'Invalid referral code.' });
    }
    if (referrer.email && referrer.email === cleanEmail) {
      return res.status(400).json({ error: 'You cannot refer yourself.' });
    }
  }

  const newCode = generateCode();

  const joinTx = db.transaction(() => {
    const info = s.insertUser.run({
      full_name: full_name.trim(),
      email: cleanEmail || null,
      phone: phone || null,
      referral_code: newCode,
      referrer_id: referrer ? referrer.id : null,
    });
    const newUserId = info.lastInsertRowid;

    if (referrer) {
      s.insertReferral.run({ referrer_id: referrer.id, referred_user_id: newUserId });
      s.bumpReferrer.run({ boost: BOOST_PER_REFERRAL, id: referrer.id });
      processRewards(referrer);
    }

    return newUserId;
  });

  try {
    const newUserId = joinTx();
    const user = s.findById.get(newUserId);
    const total = s.countUsers.get().cnt;
    const rank = computeDisplayRank(newUserId, total);

    const top10 = s.leaderboard.all(10).map((u, i) => ({
      rank: MAX_WAITLIST - total + i + 1,
      display_name: displayName(u),
      referrals: u.referral_count,
      boost_points: u.boost_points,
      badge: !!u.vip_badge,
    }));

    const response = {
      ...userPayload(user, rank, total),
      leaderboard_preview: top10,
    };

    if (referrer) {
      const referrerRefreshed = s.findById.get(referrer.id);
      const referrerRank = computeDisplayRank(referrer.id, total);
      response.referrer_update = {
        referrer_new_rank: referrerRank,
        referrer_boost_points: referrerRefreshed.boost_points,
        referrer_referral_count: referrerRefreshed.referral_count,
      };
    }

    return res.status(201).json(response);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'This email or phone is already on the waitlist.' });
    }
    throw err;
  }
});

// ─── GET /api/waitlist/me ────────────────────────────────────────────
router.get('/me', (req, res) => {
  const s = prepareStatements();
  const { user_id, email } = req.query;

  let user;
  if (user_id) {
    user = s.findById.get(Number(user_id));
  } else if (email) {
    user = s.findByEmail.get(email.trim().toLowerCase());
  }

  if (!user) {
    return res.status(404).json({ error: 'User not found on waitlist.' });
  }

  const totalUsers = s.countUsers.get().cnt;
  const rank = computeDisplayRank(user.id, totalUsers);

  const top10 = s.leaderboard.all(10).map((u, i) => ({
    rank: MAX_WAITLIST - totalUsers + i + 1,
    display_name: displayName(u),
    referrals: u.referral_count,
    boost_points: u.boost_points,
    badge: !!u.vip_badge,
  }));

  return res.json({
    ...userPayload(user, rank, totalUsers),
    leaderboard_preview: top10,
    progress_to_next_reward: getNextReward(user.referral_count),
  });
});

// ─── GET /api/waitlist/leaderboard ───────────────────────────────────
router.get('/leaderboard', (req, res) => {
  const s = prepareStatements();
  const limit = Math.min(Number(req.query.limit) || 50, 100);

  const rows = s.leaderboard.all(limit);
  const totalUsers = s.countUsers.get().cnt;

  const leaderboard = rows.map((u, i) => ({
    rank: MAX_WAITLIST - totalUsers + i + 1,
    display_name: displayName(u),
    referrals: u.referral_count,
    boost_points: u.boost_points,
    badge: !!u.vip_badge,
    joined: u.created_at,
  }));

  return res.json({ total_users: totalUsers, leaderboard });
});

module.exports = router;
