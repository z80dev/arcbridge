import {
  BrowserProvider,
  Contract,
  parseUnits,
  formatUnits,
  zeroPadValue,
  ZeroHash,
  getAddress,
} from 'https://esm.sh/ethers@6.17.0';

const BASE_CHAIN_ID = 8453;
const BASE_DOMAIN = 6;
const ARC_DOMAIN = 26;
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TOKEN_MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
const FORWARD_HOOK_DATA =
  '0x636374702d666f72776172640000000000000000000000000000000000000000';
const DESTINATION_CALLER = ZeroHash;
const FEE_API = 'https://iris-api.circle.com/v2/burn/USDC/fees/6/26?forward=true';
const POLL_INTERVAL_MS = 6000;
const POLL_TIMEOUT_MS = 20 * 60 * 1000;
const TX_HASH_RE = /^0x[0-9a-f]{64}$/i;
const BASE_EXPLORER = 'https://basescan.org/tx/';
const ARC_EXPLORER = 'https://explorer.arc.io/tx/';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];
const MESSENGER_ABI = [
  'function depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)',
  'function remoteTokenMessengers(uint32) view returns (bytes32)',
];

const $ = (id) => document.getElementById(id);
const connectBtn = $('connect-btn');
const accountLine = $('account-line');
const chainLine = $('chain-line');
const amountInput = $('amount-input');
const recipientInput = $('recipient-input');
const bridgeBtn = $('bridge-btn');
const errorBox = $('error-box');
const resultCard = $('result-card');
const burnLink = $('burn-link');
const forwardLink = $('forward-link');
const quoteNote = $('quote-note');
const qForward = $('q-forward');
const qProtocol = $('q-protocol');
const qMax = $('q-max');
const qNet = $('q-net');
const stepEls = Object.fromEntries(
  [...document.querySelectorAll('#steps li')].map((li) => [li.dataset.step, li]),
);

let provider = null;
let account = null;
let quote = null; // { amount, maxFee, protocolFee, forwardFee, net, threshold }
let quoteTimer = null;

function setError(msg) {
  if (!msg) {
    errorBox.textContent = '';
    errorBox.classList.add('hidden');
    return;
  }
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
}

function setStep(name, state) {
  const el = stepEls[name];
  if (!el) return;
  el.classList.remove('active', 'done', 'failed');
  if (state) el.classList.add(state);
}

function resetSteps() {
  for (const el of Object.values(stepEls)) el.classList.remove('active', 'done', 'failed');
}

function isUserRejection(err) {
  const code = err?.code ?? err?.info?.error?.code;
  return (
    code === 4001 ||
    code === 'ACTION_REJECTED' ||
    /user rejected|user denied/i.test(err?.message ?? err?.shortMessage ?? '')
  );
}

function selectedThreshold() {
  const v = document.querySelector('input[name="finality"]:checked')?.value;
  return v === 'standard' ? 2000 : 1000;
}

function parseAmount() {
  const raw = amountInput.value.trim();
  if (!raw) return null;
  try {
    const amt = parseUnits(raw, 6);
    return amt > 0n ? amt : null;
  } catch {
    return null;
  }
}

function parseRecipient() {
  const raw = recipientInput.value.trim();
  if (!raw) return null;
  try {
    return getAddress(raw);
  } catch {
    return null;
  }
}

function fmt(usdc) {
  return `${formatUnits(usdc, 6)} USDC`;
}

async function ensureBaseChain() {
  const eth = window.ethereum;
  const chainId = await eth.request({ method: 'eth_chainId' });
  if (parseInt(chainId, 16) === BASE_CHAIN_ID) return;
  try {
    await eth.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x2105' }],
    });
  } catch (err) {
    if (err?.code === 4902) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: '0x2105',
            chainName: 'Base',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://mainnet.base.org'],
          },
        ],
      });
    } else {
      throw err;
    }
  }
  const after = await eth.request({ method: 'eth_chainId' });
  if (parseInt(after, 16) !== BASE_CHAIN_ID) {
    throw new Error('Please switch to the Base network to continue.');
  }
}

function pickTier(feePayload, threshold) {
  const list = Array.isArray(feePayload)
    ? feePayload
    : (feePayload?.fees ?? feePayload?.tiers ?? feePayload?.data ?? []);
  const tiers = Array.isArray(list) ? list : [list];
  return (
    tiers.find((t) => Number(t?.finalityThreshold) === threshold) ??
    tiers.find((t) => t?.finalityThreshold != null) ??
    null
  );
}

async function refreshQuote() {
  quote = null;
  qForward.textContent = qProtocol.textContent = qMax.textContent = qNet.textContent = '\u2014';
  quoteNote.textContent = '';
  setStep('quote', 'active');
  bridgeBtn.disabled = true;

  const amount = parseAmount();
  if (amount == null) {
    quoteNote.textContent = 'Enter a USDC amount to fetch a quote.';
    setStep('quote', null);
    return;
  }
  const threshold = selectedThreshold();
  try {
    const res = await fetch(FEE_API);
    if (!res.ok) throw new Error(`Fee API returned ${res.status}.`);
    const payload = await res.json();
    const tier = pickTier(payload, threshold);
    if (!tier) throw new Error('No fee tier returned by the Circle fee API.');

    const forwardFeeHigh = BigInt(tier.forwardFee?.high ?? tier.forwardFee?.med ?? tier.forwardFee?.medium ?? 25000);
    const minimumFeeBps = Number(tier.minimumFee ?? 0);
    const scaledBps = BigInt(Math.ceil(minimumFeeBps * 100));
    const protocolFee = (amount * scaledBps + 999999n) / 1000000n;
    const maxFee = protocolFee + forwardFeeHigh + 5000n;
    if (amount <= maxFee) {
      quoteNote.textContent = `Amount too small: max fee is ${fmt(maxFee)}.`;
      setStep('quote', 'failed');
      return;
    }
    quote = { amount, maxFee, protocolFee, forwardFee: forwardFeeHigh, net: amount - maxFee, threshold };
    qForward.textContent = fmt(forwardFeeHigh);
    qProtocol.textContent = fmt(protocolFee);
    qMax.textContent = fmt(maxFee);
    qNet.textContent = fmt(quote.net);
    quoteNote.textContent =
      threshold === 1000 ? 'Fast finality (threshold 1000).' : 'Standard finality (threshold 2000).';
    setStep('quote', 'done');
    if (account && parseRecipient()) bridgeBtn.disabled = false;
  } catch (err) {
    quoteNote.textContent = `Quote failed: ${err.message}`;
    setStep('quote', 'failed');
  }
}

function scheduleQuote() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(refreshQuote, 350);
}

async function connect() {
  setError(null);
  if (!window.ethereum) {
    setError('No EIP-1193 wallet found. Install a wallet extension to continue.');
    return;
  }
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    account = getAddress(accounts[0]);
    await ensureBaseChain();
    provider = new BrowserProvider(window.ethereum);
    connectBtn.textContent = 'Connected';
    accountLine.textContent = `Account: ${account}`;
    chainLine.textContent = 'Chain: Base (8453)';
    if (!recipientInput.value.trim()) recipientInput.value = account;
    await refreshQuote();
  } catch (err) {
    if (isUserRejection(err)) {
      setError('Connection cancelled in wallet.');
    } else {
      setError(err.message ?? 'Wallet connection failed.');
    }
  }
}

async function pollForwardTx(burnHash) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the Arc forward tx (20 min). Try again later — your burn tx is final on Base.');
    }
    let data = null;
    try {
      const res = await fetch(
        `https://iris-api.circle.com/v2/messages/6?transactionHash=${burnHash}`,
      );
      if (res.ok) data = await res.json();
    } catch {
      data = null; // transient network error: keep polling
    }
    const messages = Array.isArray(data) ? data : (data?.messages ?? []);
    for (const m of messages) {
      const fwd = m?.forwardTxHash ?? m?.forwardTransactionHash;
      if (typeof fwd === 'string' && TX_HASH_RE.test(fwd)) return fwd;
      // Complete-without-forwardTxHash stays pending: never resolve on status alone.
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

function showTxLink(el, hash, base) {
  el.textContent = `${hash.slice(0, 10)}\u2026${hash.slice(-8)}`;
  el.href = TX_HASH_RE.test(hash) ? base + hash : '#';
}

async function bridge() {
  setError(null);
  resultCard.classList.add('hidden');
  resetSteps();
  if (!window.ethereum || !provider || !account) {
    setError('Connect your wallet first.');
    return;
  }
  const recipient = parseRecipient();
  if (!recipient) {
    setError('Recipient address is invalid. Check the checksum and try again.');
    return;
  }
  if (!quote || quote.amount !== parseAmount()) {
    await refreshQuote();
  }
  if (!quote) {
    setError('No valid fee quote. Fix the amount and try again.');
    return;
  }
  const { amount, maxFee, threshold } = quote;

  let signer;
  try {
    await ensureBaseChain();
    signer = await provider.getSigner();
  } catch (err) {
    setError(isUserRejection(err) ? 'Cancelled in wallet.' : (err.message ?? 'Failed to access signer.'));
    return;
  }

  try {
    const usdc = new Contract(BASE_USDC, ERC20_ABI, signer);
    const messenger = new Contract(TOKEN_MESSENGER, MESSENGER_ABI, signer);

    // Preflight: Arc must be registered on the Base messenger.
    const remote = await messenger.remoteTokenMessengers(ARC_DOMAIN);
    const expected = zeroPadValue(TOKEN_MESSENGER, 32).toLowerCase();
    if (String(remote).toLowerCase() !== expected) {
      throw new Error('Preflight failed: Arc messenger not registered on Base messenger. Aborting.');
    }

    setStep('approve', 'active');
    const allowance = await usdc.allowance(account, TOKEN_MESSENGER);
    if (allowance < amount) {
      const approveTx = await usdc.approve(TOKEN_MESSENGER, amount);
      const approveReceipt = await approveTx.wait();
      if (approveReceipt?.status !== 1) throw new Error('USDC approval reverted on Base.');
    }
    setStep('approve', 'done');

    setStep('burn', 'active');
    const mintRecipient = zeroPadValue(recipient, 32);
    const burnTx = await messenger.depositForBurnWithHook(
      amount,
      ARC_DOMAIN,
      mintRecipient,
      BASE_USDC,
      DESTINATION_CALLER,
      maxFee,
      threshold,
      FORWARD_HOOK_DATA,
    );
    const burnReceipt = await burnTx.wait();
    if (burnReceipt?.status !== 1) throw new Error('Burn reverted on Base.');
    const burnHash = burnTx.hash;
    if (!TX_HASH_RE.test(burnHash)) throw new Error('Burn tx returned an invalid hash.');
    setStep('burn', 'done');
    showTxLink(burnLink, burnHash, BASE_EXPLORER);
    resultCard.classList.remove('hidden');

    setStep('poll', 'active');
    const forwardHash = await pollForwardTx(burnHash);
    setStep('poll', 'done');
    showTxLink(forwardLink, forwardHash, ARC_EXPLORER);
    setStep('done', 'done');
  } catch (err) {
    for (const name of ['approve', 'burn', 'poll']) {
      if (stepEls[name]?.classList.contains('active')) setStep(name, 'failed');
    }
    setError(isUserRejection(err) ? 'Cancelled in wallet.' : (err.message ?? 'Bridge failed.'));
  }
}

connectBtn.addEventListener('click', connect);
bridgeBtn.addEventListener('click', bridge);
amountInput.addEventListener('input', scheduleQuote);
recipientInput.addEventListener('input', () => {
  setError(null);
  bridgeBtn.disabled = !(account && quote && parseRecipient() && quote.amount === parseAmount());
});
for (const radio of document.querySelectorAll('input[name="finality"]')) {
  radio.addEventListener('change', scheduleQuote);
}
if (window.ethereum) {
  window.ethereum.on?.('accountsChanged', (accounts) => {
    account = accounts?.[0] ? getAddress(accounts[0]) : null;
    accountLine.textContent = account ? `Account: ${account}` : 'Not connected.';
    if (account && !recipientInput.value.trim()) recipientInput.value = account;
    scheduleQuote();
  });
  window.ethereum.on?.('chainChanged', () => window.location.reload());
}
