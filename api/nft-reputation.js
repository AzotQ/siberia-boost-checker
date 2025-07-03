import fetch from 'node-fetch';

const TRANSFERS_URL         = 'https://dialog-tbot.com/history/nft-transfers/';
const UNIQUE_REPUTATION_URL = 'https://dialog-tbot.com/nft/unique-reputation/';
const DEFAULT_LIMIT         = 200;
const DEFAULT_SKIP          = 0;

export default async function handler(req, res) {
    const walletId = req.query.wallet_id;
    const limit    = Number(req.query.limit) || DEFAULT_LIMIT;
    const skip     = Number(req.query.skip)  || DEFAULT_SKIP;

    // Optional filter by date
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
        // Download all incoming NFT transfers by pagination, filtering only method='nft_transfer'
        const allTransfers = [];
        let offset     = skip;
        let totalCount = Infinity;
        do {
            const url = new URL(TRANSFERS_URL);
            url.searchParams.set('wallet_id', walletId);
            url.searchParams.set('direction',  'in');
            url.searchParams.set('limit',      String(limit));
            url.searchParams.set('skip',       String(offset));

            const resp = await fetch(url.toString());
            if (!resp.ok) break;
            const json = await resp.json();
            if (typeof json.total === 'number') totalCount = json.total;

            const batch = Array.isArray(json.nft_transfers) ? json.nft_transfers : [];
            if (batch.length === 0) break;

            batch.forEach(tx => {
                if (tx.method !== 'nft_transfer') return;
                if (startNano !== null || endNano !== null) {
                    if (!tx.timestamp_nanosec) return;
                    const ts = BigInt(tx.timestamp_nanosec);
                    if (startNano !== null && ts < startNano) return;
                    if (endNano   !== null && ts > endNano)   return;
                }
                allTransfers.push(tx);
            });

            offset += limit;
        } while (offset < totalCount);

        // Load map title→reputation
        const repResp = await fetch(UNIQUE_REPUTATION_URL);
        const repMap  = {};
        if (repResp.ok) {
            const repJson = await repResp.json();
            const records = Array.isArray(repJson.nfts) ? repJson.nfts : [];
            records.forEach(item => {
                if (typeof item.title === 'string' && typeof item.reputation === 'number') {
                    repMap[item.title.trim().toLowerCase()] = item.reputation;
                }
            });
        } else {
            console.warn(`Unique-reputation API returned ${repResp.status}, skipping reputations`);
        }

        // Group by sender_id, collect total, tokens and date of first shipment
        const bySender = {};
        allTransfers.forEach(tx => {
            const from  = tx.sender_id;
            const title = (tx.args?.title || '').trim().toLowerCase();
            if (!title) return;

            const rep = repMap[title] || 0;
            const ts  = tx.timestamp_nanosec
                ? BigInt(tx.timestamp_nanosec)
                : null;

            if (!bySender[from]) {
                // at first appearance - initialize total, tokens and firstTs
                bySender[from] = { total: 0, tokens: {}, firstTs: ts };
            } else if (ts !== null && ts < bySender[from].firstTs) {
                // update if we find an earlier shipment.
                bySender[from].firstTs = ts;
            }

            bySender[from].total += rep;

            if (!bySender[from].tokens[title]) {
                bySender[from].tokens[title] = { title, count: 0, rep, totalRep: 0 };
            }
            const rec = bySender[from].tokens[title];
            rec.count    += 1;
            rec.totalRep  = rec.count * rec.rep;
        });

        // Form an array, sort by firstTs (oldest at the beginning), remove firstTs from the final output
        const leaderboard = Object.entries(bySender)
            .map(([wallet, { total, tokens, firstTs }]) => ({
                wallet,
                total,
                tokens: Object.values(tokens),
                firstTs
            }))
            .sort((a, b) => {
                if (a.firstTs < b.firstTs) return -1;
                if (a.firstTs > b.firstTs) return 1;
                return 0;
            })
            .map(({ firstTs, ...rest }) => rest);

        return res.status(200).json({ leaderboard });
    } catch (err) {
        console.error('Error in nft-reputation handler:', err);
        return res.status(500).json({ error: err.message });
    }
}
