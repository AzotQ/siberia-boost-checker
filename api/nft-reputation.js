import fetch from 'node-fetch';
import { fetchYUMTransfers } from './yum-rewards.js';

const TRANSFERS_URL = 'https://dialog-tbot.com/history/nft-transfers/';
const UNIQUE_REPUTATION_URL = 'https://dialog-tbot.com/nft/unique-reputation/';
const DEFAULT_LIMIT = 200;
const DEFAULT_SKIP = 0;

export default async function handler(req, res) {
    const walletId = req.query.wallet_id;
    const limit = Number(req.query.limit) || DEFAULT_LIMIT;
    const skip = Number(req.query.skip) || DEFAULT_SKIP;

    let startNano = null, endNano = null;
    if (req.query.start_time) {
        const d = Date.parse(req.query.start_time);
        if (!Number.isNaN(d)) startNano = BigInt(d) * 1_000_000n;
    }
    if (req.query.end_time) {
        const d = Date.parse(req.query.end_time);
        if (!Number.isNaN(d)) endNano = BigInt(d) * 1_000_000n;
    }

    if (!walletId) {
        return res.status(400).json({ error: 'Parameter wallet_id is required' });
    }

    try {
        const allTransfers = [];
        const nftFirstTs = {};
        let offset = skip;
        let totalCount = Infinity;

        do {
            const url = new URL(TRANSFERS_URL);
            url.searchParams.set('wallet_id', walletId);
            url.searchParams.set('direction', 'in');
            url.searchParams.set('limit', String(limit));
            url.searchParams.set('skip', String(offset));

            const resp = await fetch(url.toString());
            if (!resp.ok) break;
            const json = await resp.json();
            if (typeof json.total === 'number') totalCount = json.total;

            const batch = Array.isArray(json.nft_transfers) ? json.nft_transfers : [];
            if (!batch.length) break;

            batch.forEach(tx => {
                if (tx.method !== 'nft_transfer') return;
                if (startNano !== null || endNano !== null) {
                    if (!tx.timestamp_nanosec) return;
                    const ts = BigInt(tx.timestamp_nanosec);
                    if (startNano !== null && ts < startNano) return;
                    if (endNano !== null && ts > endNano) return;
                }

                allTransfers.push(tx);

                // save the first timestamp by sender_id
                const from = tx.sender_id;
                const ts = BigInt(tx.timestamp_nanosec);
                if (!nftFirstTs[from] || ts < BigInt(nftFirstTs[from])) {
                    nftFirstTs[from] = tx.timestamp_nanosec;
                }
            });

            offset += limit;
        } while (offset < totalCount);

        const repResp = await fetch(UNIQUE_REPUTATION_URL);
        const repMap = {};
        if (repResp.ok) {
            const repJson = await repResp.json();
            const records = Array.isArray(repJson.nfts) ? repJson.nfts : [];
            records.forEach(item => {
                if (typeof item.title === 'string' && typeof item.reputation === 'number') {
                    repMap[item.title.trim().toLowerCase()] = item.reputation;
                }
            });
        } else {
            console.warn(`Unique-reputation API returned ${repResp.status}`);
        }

        const bySender = {};
        allTransfers.forEach(tx => {
            const from = tx.sender_id;
            const title = (tx.args?.title || '').trim().toLowerCase();
            if (!title) return;
            const rep = repMap[title] || 0;

            if (!bySender[from]) {
                bySender[from] = { total: 0, nftCount: 0, tokens: {} };
            }

            bySender[from].total += rep;
            bySender[from].nftCount += 1;

            if (!bySender[from].tokens[title]) {
                bySender[from].tokens[title] = { title, count: 0, rep, totalRep: 0 };
            }
            const rec = bySender[from].tokens[title];
            rec.count += 1;
            rec.totalRep = rec.count * rec.rep;
        });

        let leaderboard = Object.entries(bySender)
            .map(([wallet, { total, nftCount, tokens }]) => ({
                wallet,
                total,
                nftCount,
                tokens: Object.values(tokens),
                yum: 0,
                firstNftTs: nftFirstTs[wallet] || null
            }));

        const yumTransfers = await fetchYUMTransfers(walletId, 'SBR', 200, startNano, endNano);
        const yumBySender = {};

        yumTransfers.forEach(tx => {
            const { to, amount } = tx;
            if (!to || typeof amount !== 'number') return;
            if (!yumBySender[to]) yumBySender[to] = 0;
            yumBySender[to] += amount;
        });

        leaderboard.forEach(entry => {
            entry.yum = yumBySender[entry.wallet] || 0;
        });

        // Sort by date of first NFT transfer
        leaderboard.sort((a, b) => {
            if (!a.firstNftTs) return 1;
            if (!b.firstNftTs) return -1;
            const tsA = BigInt(a.firstNftTs);
            const tsB = BigInt(b.firstNftTs);
            if (tsA < tsB) return -1;
            if (tsA > tsB) return 1;
            return 0;
        });

        return res.status(200).json({ leaderboard });

    } catch (err) {
        console.error('❌ Error in nft-reputation handler:', err);
        return res.status(500).json({ error: err.message, stack: err.stack });
    }
}
