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
        // --- 1. Собираем отправителей NFT
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

        // Репутация по NFT
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

        // --- 2. Собираем по каждому отправителю NFT его данные
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

        // --- 3. Собираем отправителей токенов (SBR)
        const yumTransfers = await fetchYUMTransfers(walletId, 'SBR', 200, startNano, endNano);
        const yumBySender = {};
        const tokenFirstTs = {};

        yumTransfers.forEach(tx => {
            const { from, amount, ts } = tx;
            if (!from || typeof amount !== 'number') return;
            if (!yumBySender[from]) yumBySender[from] = 0;
            yumBySender[from] += amount;

            if (ts) {
                if (!tokenFirstTs[from] || BigInt(ts) < BigInt(tokenFirstTs[from])) {
                    tokenFirstTs[from] = ts;
                }
            }
        });

        // --- 4. Собрать всех уникальных отправителей (NFT или токены)
        const allSenders = new Set([
            ...Object.keys(bySender),
            ...Object.keys(yumBySender)
        ]);

        // --- 5. Формируем итоговый leaderboard
        const leaderboard = [];
        for (const sender of allSenders) {
            leaderboard.push({
                wallet: sender,
                total: bySender[sender]?.total || 0,
                nftCount: bySender[sender]?.nftCount || 0,
                tokens: bySender[sender] ? Object.values(bySender[sender].tokens) : [],
                yum: yumBySender[sender] || 0,
                firstNftTs: nftFirstTs[sender] || null,
                firstTokenTs: tokenFirstTs[sender] || null,
                // для сортировки можно добавить минимальный ts из обоих
                firstTxTs: nftFirstTs[sender] && tokenFirstTs[sender]
                    ? String(BigInt(nftFirstTs[sender]) < BigInt(tokenFirstTs[sender]) ? nftFirstTs[sender] : tokenFirstTs[sender])
                    : (nftFirstTs[sender] || tokenFirstTs[sender] || null)
            });
        }

        // --- 6. Сортировка по дате первой транзакции
        leaderboard.sort((a, b) => {
            if (!a.firstTxTs) return 1;
            if (!b.firstTxTs) return -1;
            const tsA = BigInt(a.firstTxTs);
            const tsB = BigInt(b.firstTxTs);
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
