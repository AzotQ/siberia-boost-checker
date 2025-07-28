import fetch from 'node-fetch';

const BASE_URL = 'https://dialog-tbot.com/history/ft-transfers/';
const DEFAULT_LIMIT = 100;

export async function fetchYUMTransfers(walletId, symbol = 'SBR', batch = DEFAULT_LIMIT, startNano = null, endNano = null) {
    const all = [];
    for (let skip = 0; ; skip += batch) {
        const url = new URL(BASE_URL);
        url.searchParams.set('wallet_id', walletId);
        url.searchParams.set('direction', 'in');
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
            // Check that timestamp_nanosec exists and it is a string/number cast to BigInt
            const tsRaw = tx.timestamp_nanosec;
            // tsRaw must be a number or a string consisting entirely of digits
            if (!tsRaw || !/^\d+$/.test(String(tsRaw))) return false;
            const ts = BigInt(tsRaw);
            if (startNano !== null && ts < startNano) return false;
            if (endNano !== null && ts > endNano) return false;
            return true;
        })
        .map(tx => {
            const decimals = Number(tx.decimals || 0);
            const raw = BigInt(tx.amount || '0');
            return {
                from: tx.from,
                amount: Number(raw) / 10 ** decimals,
                ts: tx.timestamp_nanosec
            };
        });
}
