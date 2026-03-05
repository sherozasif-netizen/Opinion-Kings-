const db = require('../_db');
const { MAX_WAITLIST, displayName } = require('../_utils');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const allUsers = await db.get('waitlist_users?select=id,full_name,email,boost_points,referral_count,vip_badge,created_at&order=created_at.asc');
    const total = allUsers.length;

    const sorted = [...allUsers].sort((a, b) => {
      if ((b.boost_points || 0) !== (a.boost_points || 0)) {
        return (b.boost_points || 0) - (a.boost_points || 0);
      }
      return new Date(a.created_at) - new Date(b.created_at);
    });

    const leaderboard = sorted.slice(0, limit).map((u, i) => ({
      rank: MAX_WAITLIST - total + i + 1,
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
