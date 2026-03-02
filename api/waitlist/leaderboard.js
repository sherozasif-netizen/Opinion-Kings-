const db = require('../_db');
const { MAX_WAITLIST, displayName } = require('../_utils');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const allUsers = await db.get('waitlist_users?select=id,full_name,email,boost_points,referral_count,vip_badge,created_at&order=created_at.asc');
    const total = allUsers.length;

    const ranked = allUsers.map((u, i) => ({
      ...u,
      rank: Math.max(1, MAX_WAITLIST - total + i + 1 - (u.boost_points || 0)),
    })).sort((a, b) => a.rank - b.rank);

    const leaderboard = ranked.slice(0, limit).map(u => ({
      rank: u.rank,
      display_name: displayName(u),
      referrals: u.referral_count,
      boost_points: u.boost_points,
      badge: !!u.vip_badge,
      joined: u.created_at,
    }));

    return res.json({ total_users: total, leaderboard });
  } catch (err) {
    console.error('LEADERBOARD ERROR:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
};
