const db = require('../_db');
const {
  generateCode, MAX_WAITLIST, BOOST_PER_REFERRAL,
  REWARD_MILESTONES, getNextReward, displayName, userPayload,
} = require('../_utils');

async function computeRank(userId, total) {
  const user = await db.getOne('waitlist_users', `id=eq.${userId}`);
  if (!user) return total;
  const ahead = await db.getAll(
    'waitlist_users',
    `or=(boost_points.gt.${user.boost_points},and(boost_points.eq.${user.boost_points},created_at.lt.${user.created_at}))`,
    'id'
  );
  const pos = ahead.length + 1;
  return MAX_WAITLIST - total + pos;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { full_name, email, phone, referral_code } = req.body;

    if (!email && !phone) return res.status(400).json({ error: 'Email or phone is required.' });
    if (!full_name || !full_name.trim()) return res.status(400).json({ error: 'Full name is required.' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format.' });

    const existing = await db.getOne('waitlist_users', `email=eq.${encodeURIComponent(email)}`);
    if (existing) {
      const total = await db.count('waitlist_users');
      const rank = await computeRank(existing.id, total);
      return res.json({ already_joined: true, ...userPayload(existing, rank, total) });
    }

    const total = await db.count('waitlist_users');
    if (total >= MAX_WAITLIST) return res.status(409).json({ error: 'Waitlist is full. Stay tuned for launch!' });

    let referrer = null;
    if (referral_code) {
      referrer = await db.getOne('waitlist_users', `referral_code=eq.${encodeURIComponent(referral_code)}`);
      if (!referrer) return res.status(400).json({ error: 'Invalid referral code.' });
      if (referrer.email && referrer.email === email) return res.status(400).json({ error: 'You cannot refer yourself.' });
    }

    const newCode = generateCode();
    const inserted = await db.insert('waitlist_users', {
      full_name: full_name.trim(),
      email: email || null,
      phone: phone || null,
      referral_code: newCode,
      referrer_id: referrer ? referrer.id : null,
    });
    const user = inserted[0];

    if (referrer) {
      await db.insert('referrals', { referrer_id: referrer.id, referred_user_id: user.id });
      await db.update('waitlist_users', `id=eq.${referrer.id}`, {
        referral_count: referrer.referral_count + 1,
        boost_points: referrer.boost_points + BOOST_PER_REFERRAL,
      });

      const updatedReferrer = await db.getOne('waitlist_users', `id=eq.${referrer.id}`);
      for (const m of REWARD_MILESTONES) {
        if (updatedReferrer.referral_count >= m.threshold) {
          const already = await db.getOne('reward_events', `user_id=eq.${referrer.id}&type=eq.${m.type}`);
          if (!already) {
            await db.insert('reward_events', { user_id: referrer.id, type: m.type, amount: m.credits });
            if (m.credits > 0) {
              await db.update('waitlist_users', `id=eq.${referrer.id}`, {
                credits_earned: updatedReferrer.credits_earned + m.credits,
              });
            }
            if (m.vip) {
              await db.update('waitlist_users', `id=eq.${referrer.id}`, { vip_badge: true });
            }
          }
        }
      }
    }

    const newTotal = await db.count('waitlist_users');
    const rank = await computeRank(user.id, newTotal);

    const topRows = await db.getAll('waitlist_users', '', '*', 'boost_points.desc,created_at.asc&limit=10');
    const top10 = topRows.map((u, i) => ({
      rank: MAX_WAITLIST - newTotal + i + 1,
      display_name: displayName(u),
      referrals: u.referral_count,
      boost_points: u.boost_points,
      badge: !!u.vip_badge,
    }));

    const response = { ...userPayload(user, rank, newTotal), leaderboard_preview: top10 };

    if (referrer) {
      const rr = await db.getOne('waitlist_users', `id=eq.${referrer.id}`);
      const rRank = await computeRank(referrer.id, newTotal);
      response.referrer_update = {
        referrer_new_rank: rRank,
        referrer_boost_points: rr.boost_points,
        referrer_referral_count: rr.referral_count,
      };
    }

    return res.status(201).json(response);
  } catch (err) {
    console.error('JOIN ERROR:', err);
    if (err.message && err.message.includes('duplicate')) {
      return res.status(409).json({ error: 'This email is already on the waitlist.' });
    }
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
