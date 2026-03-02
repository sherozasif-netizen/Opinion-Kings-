const { customAlphabet } = require('nanoid');

const generateCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 8);

const MAX_WAITLIST = 5000;
const BOOST_PER_REFERRAL = 100;

const REWARD_MILESTONES = [
  { threshold: 1,  type: 'BOOST_100',    credits: 0,     vip: false, label: 'Skip 100 spots' },
  { threshold: 5,  type: 'CREDITS_10',   credits: 1000,  vip: false, label: '$10 trading credits' },
  { threshold: 25, type: 'CREDITS_75',   credits: 7500,  vip: false, label: '$75 trading credits' },
  { threshold: 50, type: 'CREDITS_300',  credits: 30000, vip: true,  label: '$300 + VIP Founder badge' },
];

function getNextReward(referralCount) {
  for (const m of REWARD_MILESTONES) {
    if (referralCount < m.threshold) {
      return { referrals_needed: m.threshold - referralCount, reward: m.label };
    }
  }
  return { referrals_needed: 0, reward: 'All milestones unlocked!' };
}

function displayName(user) {
  if (user.full_name && user.full_name.trim()) {
    const parts = user.full_name.trim().split(/\s+/);
    if (parts.length >= 2) return parts[0] + ' ' + parts[parts.length - 1][0] + '.';
    return parts[0];
  }
  if (user.email) return user.email.split('@')[0];
  return 'Anonymous';
}

function userPayload(user, displayRank, totalUsers) {
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : (process.env.BASE_URL || 'http://localhost:3000');
  return {
    user_id: user.id,
    full_name: user.full_name,
    email: user.email,
    referral_code: user.referral_code,
    referral_link: `${base}/waitlist.html?ref=${user.referral_code}`,
    rank: displayRank,
    total_users: totalUsers,
    referral_count: user.referral_count,
    boost_points: user.boost_points,
    credits_earned: user.credits_earned,
    vip_badge: !!user.vip_badge,
    next_reward: getNextReward(user.referral_count),
  };
}

module.exports = {
  generateCode,
  MAX_WAITLIST,
  BOOST_PER_REFERRAL,
  REWARD_MILESTONES,
  getNextReward,
  displayName,
  userPayload,
};
