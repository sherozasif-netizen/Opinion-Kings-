const db = require('../_db');
const { MAX_WAITLIST, displayName } = require('../_utils');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const total = await db.count('waitlist_users');
    const rows = await db.getAll('waitlist_users', '', '*', `boost_points.desc,created_at.asc&limit=${limit}`);

    const leaderboard = rows.map((u, i) => ({
      rank: MAX_WAITLIST - total + i + 1,
      display_name: displayName(u),
      referrals: u.referral_count,
      boost_points: u.boost_points,
      badge: !!u.vip_badge,
      joined: u.created_at,
    }));

    return res.json({ total_users: total, leaderboard });
  } catch (err) {
    console.error('LEADERBOARD ERROR:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
};
