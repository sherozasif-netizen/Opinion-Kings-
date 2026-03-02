const db = require('../_db');
const { MAX_WAITLIST, getNextReward, displayName, userPayload } = require('../_utils');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { user_id, email } = req.query;

    let user;
    if (user_id) {
      user = await db.getOne('waitlist_users', `id=eq.${Number(user_id)}`);
    } else if (email) {
      user = await db.getOne('waitlist_users', `email=eq.${encodeURIComponent(email)}`);
    }
    if (!user) return res.status(404).json({ error: 'User not found on waitlist.' });

    const total = await db.count('waitlist_users');
    const ahead = await db.getAll(
      'waitlist_users',
      `or=(boost_points.gt.${user.boost_points},and(boost_points.eq.${user.boost_points},created_at.lt.${user.created_at}))`,
      'id'
    );
    const pos = ahead.length + 1;
    const rank = MAX_WAITLIST - total + pos;

    const topRows = await db.getAll('waitlist_users', '', '*', 'boost_points.desc,created_at.asc&limit=10');
    const top10 = topRows.map((u, i) => ({
      rank: MAX_WAITLIST - total + i + 1,
      display_name: displayName(u),
      referrals: u.referral_count,
      boost_points: u.boost_points,
      badge: !!u.vip_badge,
    }));

    return res.json({
      ...userPayload(user, rank, total),
      leaderboard_preview: top10,
      progress_to_next_reward: getNextReward(user.referral_count),
    });
  } catch (err) {
    console.error('ME ERROR:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
};
