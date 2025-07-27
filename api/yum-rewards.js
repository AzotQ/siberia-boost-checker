import fetch from 'node-fetch';

const BASE_URL = 'https://dialog-tbot.com/history/ft-transfers/';
const DEFAULT_LIMIT = 100;

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

export async function fetchYUMTransfers(walletId, symbol = 'YUM', batch = DEFAULT_LIMIT, startNano = null, endNano = null, direction = 'in') {
    const all = [];
    for (let skip = 0; ; skip += batch) {
        const url = new URL(BASE_URL);
        url.searchParams.set('wallet_id', walletId);
        url.searchParams.set('direction', direction);
        url.searchParams.set('symbol', symbol);
        url.searchParams.set('limit', batch);
        url.searchParams.set('skip', skip);

        const resp = await fetch(url.toString());
        if (!resp.ok) throw new Error(`Upstream error ${resp.status}`);
        const { transfers } = await resp.json();
        if (!Array.isArray(transfers) || transfers.length === 0) break;

        all.push(...transfers);
        if (transfers.length < batch) break;
    }

    return all
        .filter(tx => {
            const ts = tryParseBigInt(tx.timestamp_nanosec);
            if (startNano !== null && (ts === null || ts < startNano)) return false;
            if (endNano !== null && (ts === null || ts > endNano)) return false;
            return true;
        })
        .map(tx => {
            const decimals = Number(tx.decimals || 0);
            const rawAmount = tryParseBigInt(tx.amount) || 0n;
            const amount = Number(rawAmount) / 10 ** decimals;
            return {
                from: tx.from,
                to: tx.to || null,
                amount,
                timestamp_nanosec: tx.timestamp_nanosec
            };
        });
}
