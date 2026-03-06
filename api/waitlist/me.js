const db = require('../_db');
const { MAX_WAITLIST, getNextReward, displayName, userPayload } = require('../_utils');

function calcRank(allUsers, userId) {
  const sorted = [...allUsers].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const total = sorted.length;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].id === userId) {
      const baseRank = MAX_WAITLIST - total + i + 1;
      return Math.max(1, baseRank - (sorted[i].boost_points || 0));
    }
  }
  return MAX_WAITLIST;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { user_id, email } = req.query;

    let user;
    if (user_id) {
      const rows = await db.get(`waitlist_users?select=*&id=eq.${Number(user_id)}&limit=1`);
      user = rows[0];
    } else if (email) {
      const rows = await db.get(`waitlist_users?select=*&email=eq.${encodeURIComponent(email)}&limit=1`);
      user = rows[0];
    }
    if (!user) return res.status(404).json({ error: 'User not found on waitlist.' });

    const allUsers = await db.get('waitlist_users?select=id,full_name,email,boost_points,referral_count,vip_badge,created_at&order=created_at.asc');
    const total = allUsers.length;
    const rank = calcRank(allUsers, user.id);

    const ranked = allUsers.map((u, i) => ({
      ...u,
      rank: Math.max(1, MAX_WAITLIST - total + i + 1 - (u.boost_points || 0)),
    })).sort((a, b) => a.rank - b.rank);

    const top10 = ranked.slice(0, 10).map(u => ({
      rank: u.rank,
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
    console.error('ME ERROR:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
};
