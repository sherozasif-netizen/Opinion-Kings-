const db = require('../_db');
const {
  generateCode, MAX_WAITLIST, BOOST_PER_REFERRAL,
  REWARD_MILESTONES, displayName, userPayload,
} = require('../_utils');
const {
  getClientIP, isDisposableEmail, validateEmail, validateName,
  checkHoneypot, checkTimestamp, rateLimit,
} = require('../_security');

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const ip = getClientIP(req);

    if (!rateLimit(ip, 5, 3600000)) {
      return res.status(429).json({ error: 'Too many signup attempts. Please try again later.' });
    }

    const isGoogleSignIn = !!req.body.google_credential;

    if (!isGoogleSignIn) {
      if (checkHoneypot(req.body)) {
        return res.status(400).json({ error: 'Signup failed.' });
      }
      if (!checkTimestamp(req.body)) {
        return res.status(400).json({ error: 'Please fill the form properly and try again.' });
      }
    }

    if (isGoogleSignIn && process.env.GOOGLE_CLIENT_ID) {
      try {
        const tokenRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${req.body.google_credential}`);
        const tokenData = await tokenRes.json();
        if (tokenData.aud !== process.env.GOOGLE_CLIENT_ID) {
          return res.status(400).json({ error: 'Invalid Google sign-in.' });
        }
      } catch (_) {
        return res.status(400).json({ error: 'Google verification failed.' });
      }
    }

    const { full_name, email, phone, referral_code } = req.body;

    if (!full_name || !validateName(full_name)) {
      return res.status(400).json({ error: 'Please enter a valid full name (at least 2 characters).' });
    }

    if (!email && !phone) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const cleanEmail = email ? email.trim().toLowerCase() : null;

    if (cleanEmail && !validateEmail(cleanEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    if (cleanEmail && isDisposableEmail(cleanEmail)) {
      return res.status(400).json({ error: 'Please use a permanent email address (temporary/disposable emails are not allowed).' });
    }

    const existingRows = await db.get(`waitlist_users?select=*&email=eq.${encodeURIComponent(cleanEmail)}&limit=1`);
    if (existingRows.length > 0) {
      const existing = existingRows[0];
      const allUsers = await db.get('waitlist_users?select=id,boost_points,created_at&order=created_at.asc');
      const total = allUsers.length;
      const rank = calcRank(allUsers, existing.id);
      return res.json({ already_joined: true, ...userPayload(existing, rank, total) });
    }
 
    const allBefore = await db.get('waitlist_users?select=id');
    if (allBefore.length >= MAX_WAITLIST) {
      return res.status(409).json({ error: 'Waitlist is full. Stay tuned for launch!' });
    }

    let referrer = null;
    if (referral_code && referral_code.trim()) {
      const cleanCode = referral_code.trim().toUpperCase(); 
      const refRows = await db.get(`waitlist_users?select=*&referral_code=eq.${encodeURIComponent(cleanCode)}&limit=1`);
      referrer = refRows[0] || null;
      if (!referrer) return res.status(400).json({ error: 'Invalid referral code.' });
      if (referrer.email && referrer.email === cleanEmail) {
        return res.status(400).json({ error: 'You cannot refer yourself.' });
      }
    }

    const prefix = full_name.trim().replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
    const newCode = prefix + generateCode();
    const inserted = await db.post('waitlist_users', {
      full_name: full_name.trim(),
      email: cleanEmail,
      phone: phone || null,
      referral_code: newCode,
      referrer_id: referrer ? referrer.id : null,
    });
    const user = inserted[0];

    if (referrer) {
      try { await db.post('referrals', { referrer_id: referrer.id, referred_user_id: user.id }); } catch (_) {}
      await db.patch('waitlist_users', `id=eq.${referrer.id}`, {
        referral_count: referrer.referral_count + 1,
        boost_points: referrer.boost_points + BOOST_PER_REFERRAL,
      });

      const updatedRef = (await db.get(`waitlist_users?select=*&id=eq.${referrer.id}&limit=1`))[0];
      let runningCredits = updatedRef.credits_earned;
      for (const m of REWARD_MILESTONES) {
        if (updatedRef.referral_count >= m.threshold) {
          const alreadyRows = await db.get(`reward_events?select=id&user_id=eq.${referrer.id}&type=eq.${encodeURIComponent(m.type)}&limit=1`);
          if (alreadyRows.length === 0) {
            await db.post('reward_events', { user_id: referrer.id, type: m.type, amount: m.credits });
            if (m.credits > 0) {
              runningCredits += m.credits;
              await db.patch('waitlist_users', `id=eq.${referrer.id}`, { credits_earned: runningCredits });
            }
            if (m.vip) await db.patch('waitlist_users', `id=eq.${referrer.id}`, { vip_badge: true });
          }
        }
      }
    }

    const freshUser = (await db.get(`waitlist_users?select=*&id=eq.${user.id}&limit=1`))[0];
    const allUsers = await db.get('waitlist_users?select=id,full_name,email,boost_points,referral_count,vip_badge,created_at&order=created_at.asc');
    const total = allUsers.length;
    const rank = calcRank(allUsers, freshUser.id);

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

    const response = { ...userPayload(freshUser, rank, total), leaderboard_preview: top10 };

    if (referrer) {
      const rr = (await db.get(`waitlist_users?select=*&id=eq.${referrer.id}&limit=1`))[0];
      const referrerRank = calcRank(allUsers.map(u => u.id === rr.id ? { ...u, boost_points: rr.boost_points } : u), rr.id);
      response.referrer_update = {
        referrer_new_rank: referrerRank,
        referrer_boost_points: rr.boost_points,
        referrer_referral_count: rr.referral_count,
      };
    }

    return res.status(201).json(response);
  } catch (err) {
    console.error('JOIN ERROR:', err.message);
    if (err.message && err.message.includes('duplicate')) {
      return res.status(409).json({ error: 'This email is already on the waitlist.' });
    }
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
