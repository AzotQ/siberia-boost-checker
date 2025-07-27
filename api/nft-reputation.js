import fetch from 'node-fetch';
import { fetchYUMTransfers } from './yum-rewards.js';

const TRANSFERS_URL = 'https://dialog-tbot.com/history/nft-transfers/';
const UNIQUE_REPUTATION_URL = 'https://dialog-tbot.com/nft/unique-reputation/';
const DEFAULT_LIMIT = 200;
const DEFAULT_SKIP = 0;

const cache = new Map();

function tryParseBigInt(value) {
    try {
        if (typeof value === 'string' && /^\d+$/.test(value)) {
            return BigInt(value);
        }
        return null;
    } catch {
        return null;
    }
}

async function* fetchNFTTransfersStream(walletId, direction, limit, startNano, endNano) {
    let skip = 0;
    let totalCount = Infinity;

    while (skip < totalCount) {
        const url = new URL(TRANSFERS_URL);
        url.searchParams.set('wallet_id', walletId);
        url.searchParams.set('direction', direction);
        url.searchParams.set('limit', String(limit));
        url.searchParams.set('skip', String(skip));

        const resp = await fetch(url.toString());
        if (!resp.ok) break;

        const json = await resp.json();
        if (typeof json.total === 'number') totalCount = json.total;

        const batch = Array.isArray(json.nft_transfers) ? json.nft_transfers : [];
        if (batch.length === 0) break;

        const filtered = batch.filter(tx => {
            if (tx.method !== 'nft_transfer') return false;
            if (startNano !== null || endNano !== null) {
                if (!tx.timestamp_nanosec) return false;
                const ts = tryParseBigInt(tx.timestamp_nanosec);
                if (ts === null) return false;
                if (startNano !== null && ts < startNano) return false;
                if (endNano !== null && ts > endNano) return false;
            }
            return true;
        });

        yield filtered;
        skip += limit;
    }
}

async function fetchAllNFTTransfers(walletId, direction, limit, startNano, endNano) {
    const allTransfers = [];
    for await (const batch of fetchNFTTransfersStream(walletId, direction, limit, startNano, endNano)) {
        allTransfers.push(...batch);
    }
    return allTransfers;
}

async function fetchReputationMap() {
    try {
        const repResp = await fetch(UNIQUE_REPUTATION_URL);
        if (!repResp.ok) {
            console.warn(`Unique-reputation API returned ${repResp.status}`);
            return {};
        }
        const repJson = await repResp.json();
        const repMap = {};
        const records = Array.isArray(repJson.nfts) ? repJson.nfts : [];
        for (const item of records) {
            if (typeof item.title === 'string' && typeof item.reputation === 'number') {
                repMap[item.title.trim().toLowerCase()] = item.reputation;
            }
        }
        return repMap;
    } catch (err) {
        console.warn('Error fetching reputation map:', err);
        return {};
    }
}

function aggregateNFTTransfers(allTransfers, repMap, direction) {
    const byKey = {};
    const nftFirstTs = {};

    for (const tx of allTransfers) {
        const from = tx.sender_id;
        const to = tx.args?.receiver_id;
        const title = (tx.args?.title || '').trim().toLowerCase();
        if (!title) continue;
        const rep = repMap[title] || 0;

        const key = direction === 'out' ? to : from;
        if (!key) continue;

        if (!byKey[key]) {
            byKey[key] = { total: 0, nftCount: 0, tokens: {} };
        }

        byKey[key].total += rep;
        byKey[key].nftCount += 1;

        if (!byKey[key].tokens[title]) {
            byKey[key].tokens[title] = { title, count: 0, rep, totalRep: 0 };
        }
        const rec = byKey[key].tokens[title];
        rec.count += 1;
        rec.totalRep = rec.count * rec.rep;

        const ts = tryParseBigInt(tx.timestamp_nanosec);
        if (ts === null) continue;
        if (!nftFirstTs[key] || ts < tryParseBigInt(nftFirstTs[key])) {
            nftFirstTs[key] = tx.timestamp_nanosec;
        }
    }

    return { byKey, nftFirstTs };
}

function aggregateTokenTransfers(tokenTransfers, direction) {
    const yumByKey = {};
    const firstYumTs = {};

    for (const tx of tokenTransfers) {
        const from = tx.from;
        const to = tx.to || null;
        const key = direction === 'out' ? to : from;
        if (!key) continue;
        if (!yumByKey[key]) yumByKey[key] = 0;
        yumByKey[key] += tx.amount;

        const ts = tryParseBigInt(tx.timestamp_nanosec || '0');
        if (ts > 0) {
            if (!firstYumTs[key] || ts < tryParseBigInt(firstYumTs[key])) {
                firstYumTs[key] = tx.timestamp_nanosec;
            }
        }
    }

    return { yumByKey, firstYumTs };
}

function buildLeaderboard(byKey, nftFirstTs, yumByKey, firstYumTs, mode) {
    const allKeys = new Set([...Object.keys(byKey), ...Object.keys(yumByKey)]);

    let leaderboard = Array.from(allKeys).map(key => {
        const nftData = byKey[key] || { total: 0, nftCount: 0, tokens: {} };
        const nftTs = nftFirstTs[key] ? tryParseBigInt(nftFirstTs[key]) : null;
        const yumTs = firstYumTs[key] ? tryParseBigInt(firstYumTs[key]) : null;

        let firstTxTs = null;
        if (nftTs !== null && yumTs !== null) {
            firstTxTs = nftTs < yumTs ? nftTs : yumTs;
        } else {
            firstTxTs = nftTs || yumTs || null;
        }

        const nftCount = (mode === 'token') ? 0 : nftData.nftCount;
        const yum = (mode === 'nft' || mode === 'nft+rep') ? 0 : (yumByKey[key] || 0);
        const total = (mode === 'token' || mode === 'token+nft') ? 0 : nftData.total;

        let tokens = Object.values(nftData.tokens);
        if (mode === 'token') {
            tokens = [];
        }

        return {
            wallet: key,
            total,
            nftCount,
            tokens,
            yum,
            firstTxTs
        };
    });

    leaderboard.sort((a, b) => {
        if (a.firstTxTs === null) return 1;
        if (b.firstTxTs === null) return -1;
        if (a.firstTxTs < b.firstTxTs) return -1;
        if (a.firstTxTs > b.firstTxTs) return 1;
        return 0;
    });

    leaderboard = leaderboard.map(item => ({
        ...item,
        firstTxTs: item.firstTxTs !== null ? item.firstTxTs.toString() : null,
    }));

    return leaderboard;
}

export default async function handler(req, res) {
    const params = {
        wallet_id: req.query.wallet_id,
        limit: Number(req.query.limit) || DEFAULT_LIMIT,
        skip: Number(req.query.skip) || DEFAULT_SKIP,
        direction: req.query.direction || 'in',
        symbol: req.query.symbol || 'YUM',
        mode: req.query.mode || 'token+nft+rep',
        start_time: req.query.start_time || '',
        end_time: req.query.end_time || '',
    };

    const cacheKey = JSON.stringify(params);
    const cachedData = cache.get(cacheKey);
    if (cachedData && cachedData.expireAt > Date.now()) {
        return res.status(200).json(cachedData.data);
    } else if (cachedData) {
        cache.delete(cacheKey);
    }

    const walletId = params.wallet_id;
    const limit = params.limit;
    const skip = params.skip;
    const direction = params.direction === 'out' ? 'out' : 'in';
    const allowedSymbols = ['YUM', 'GRECHA', 'NEAR', 'Darai', 'HOPE', 'YUPLAND', 'NTDarai', 'JHOLUDI'];
    const symbol = allowedSymbols.includes(params.symbol) ? params.symbol : 'YUM';
    const mode = params.mode;

    let startNano = null, endNano = null;
    if (params.start_time) {
        const d = Date.parse(params.start_time);
        if (!Number.isNaN(d)) startNano = BigInt(d) * 1_000_000n;
    }
    if (params.end_time) {
        const d = Date.parse(params.end_time);
        if (!Number.isNaN(d)) endNano = BigInt(d) * 1_000_000n;
    }

    if (!walletId) {
        return res.status(400).json({ error: 'Parameter wallet_id is required' });
    }

    try {
        const promises = [];

        const needNFT = mode.includes('nft');
        const needRep = mode.includes('rep');
        const needToken = !(mode === 'nft+rep' || mode === 'nft');

        let allTransfers = [];
        let repMap = {};
        let yumTransfers = [];

        if (needNFT) {
            promises.push(
                fetchAllNFTTransfers(walletId, direction, limit, startNano, endNano).then(data => allTransfers = data)
            );
        }
        if (needRep) {
            promises.push(
                fetchReputationMap().then(data => repMap = data)
            );
        }
        if (needToken) {
            promises.push(
                fetchYUMTransfers(walletId, symbol, 200, startNano, endNano, direction).then(data => yumTransfers = data)
            );
        }

        await Promise.all(promises);

        const { byKey, nftFirstTs } = aggregateNFTTransfers(allTransfers, repMap, direction);
        const { yumByKey, firstYumTs } = aggregateTokenTransfers(yumTransfers, direction);
        const leaderboard = buildLeaderboard(byKey, nftFirstTs, yumByKey, firstYumTs, mode);

        const result = { leaderboard };
        cache.set(cacheKey, { data: result, expireAt: Date.now() + 60000 });

        return res.status(200).json(result);
    } catch (err) {
        console.error('❌ Error in nft-reputation handler:', err);
        return res.status(500).json({ error: err.message, stack: err.stack });
    }
}
