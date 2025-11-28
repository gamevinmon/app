// app.js - GameVinMon dApp logic
// Network: Monad (chainId 143)
// VIN token: 0x09166bFA4a40BAbC19CCCEc6A6154d9c058098EC
// Swap:      0xCdce3485752E7a7D4323f899FEe152D9F27e890B
// Dice:      0xE9Ed2c2987da0289233A1a1AE24438A314Ad6B2f

(() => {
  // ===== Constants =====
  const RPC_URL = "https://rpc.monad.xyz";
  const MONAD_CHAIN_ID_DEC = 143;
  const MONAD_CHAIN_ID_HEX = "0x8f"; // 143 in hex

  const VIN_TOKEN_ADDRESS = "0x09166bFA4a40BAbC19CCCEc6A6154d9c058098EC";
  const SWAP_CONTRACT_ADDRESS = "0xCdce3485752E7a7D4323f899FEe152D9F27e890B";
  const DICE_CONTRACT_ADDRESS = "0xE9Ed2c2987da0289233A1a1AE24438A314Ad6B2f";

  const VIN_DECIMALS = 18;

  // ===== Minimal ABIs =====
  const VIN_TOKEN_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)"
  ];

  const SWAP_CONTRACT_ABI = [
    "function swapMonForVin() payable",
    "function swapVinForMon(uint256 vinAmount)"
  ];

  const DICE_CONTRACT_ABI = [
    "function MIN_BET() view returns (uint256)",
    "function bankroll() view returns (uint256)",
    "function play(uint256 amount, bool guessEven)",
    "event Played(address indexed player, uint256 amount, bool guessEven, bool resultEven, bool win)"
  ];

  // Approve 100,000 VIN once for Dice (large enough, not unlimited)
  const DICE_APPROVE_VIN_STRING = "100000";

  // ===== Global state =====
  let readProvider = null;
  let web3Provider = null;
  let signer = null;
  let currentAccount = null;

  let vinRead = null;
  let vinWrite = null;
  let swapRead = null;
  let swapWrite = null;
  let diceRead = null;
  let diceWrite = null;

  let vinBalanceBN = null;
  let monBalanceBN = null;

  let swapDirection = "vin-to-mon"; // "vin-to-mon" or "mon-to-vin"

  // Dice state
  let currentGuessEven = true; // true = Even, false = Odd
  let lastBetAmountBN = null;
  let lastDiceGame = null;

  // ===== DOM helpers =====
  function $(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function shortenHex(str) {
    if (!str || str.length < 10) return str || "";
    return str.slice(0, 6) + "..." + str.slice(-4);
  }

  function formatVin(bn) {
    if (!bn) return "-";
    try {
      return Number(ethers.utils.formatUnits(bn, VIN_DECIMALS)).toFixed(4);
    } catch {
      return "-";
    }
  }

  function formatMon(bn) {
    if (!bn) return "-";
    try {
      return Number(ethers.utils.formatEther(bn)).toFixed(4);
    } catch {
      return "-";
    }
  }

  function setNetworkDot(status) {
    const dot = $("networkDot");
    if (!dot) return;
    dot.classList.remove("dot-ok", "dot-wrong", "dot-disconnected");

    if (status === "ok") {
      dot.classList.add("dot-ok");
    } else if (status === "wrong") {
      dot.classList.add("dot-wrong");
    } else {
      dot.classList.add("dot-disconnected");
    }
  }

  // ===== Screens =====
  function showScreen(targetId) {
    const screens = ["home-screen", "swap-screen", "dice-screen"];
    const navMap = {
      "home-screen": "navHome",
      "swap-screen": "navSwap",
      "dice-screen": "navDice"
    };

    screens.forEach((id) => {
      const el = $(id);
      if (!el) return;
      if (id === targetId) {
        el.classList.add("screen-active");
      } else {
        el.classList.remove("screen-active");
      }
    });

    Object.entries(navMap).forEach(([screenId, navId]) => {
      const navEl = $(navId);
      if (!navEl) return;
      if (screenId === targetId) {
        navEl.classList.add("active");
      } else {
        navEl.classList.remove("active");
      }
    });
  }

  function goHome() {
    showScreen("home-screen");
  }

  function goSwap() {
    showScreen("swap-screen");
  }

  function goDice() {
    showScreen("dice-screen");
  }

  // ===== Read-only provider =====
  function initReadProvider() {
    if (typeof ethers === "undefined") {
      console.error("Ethers.js is not loaded.");
      alert("Ethers.js library is not loaded. Please check the script tag.");
      return;
    }

    readProvider = new ethers.providers.JsonRpcProvider(RPC_URL);
    vinRead = new ethers.Contract(VIN_TOKEN_ADDRESS, VIN_TOKEN_ABI, readProvider);
    swapRead = new ethers.Contract(SWAP_CONTRACT_ADDRESS, SWAP_CONTRACT_ABI, readProvider);
    diceRead = new ethers.Contract(DICE_CONTRACT_ADDRESS, DICE_CONTRACT_ABI, readProvider);

    loadMinBet();
    refreshDicePool();
  }

  async function loadMinBet() {
    const infoEl = $("diceMinInfo");
    const lineEl = $("diceMinimumText");
    if (!diceRead) return;

    try {
      if (infoEl) infoEl.textContent = "Loading minimum bet...";
      if (lineEl) lineEl.textContent = "Minimum bet: loading...";

      const minBetBN = await diceRead.MIN_BET();
      const minBetStr = ethers.utils.formatUnits(minBetBN, VIN_DECIMALS);
      const display = `Minimum bet: ${Number(minBetStr).toFixed(4)} VIN`;

      if (infoEl) infoEl.textContent = display;
      if (lineEl) lineEl.textContent = display;
    } catch (err) {
      console.error("Error loading min bet:", err);
      if (infoEl) infoEl.textContent = "Min bet: failed to load.";
      if (lineEl) lineEl.textContent = "Minimum bet: failed to load.";
    }
  }

  async function refreshDicePool() {
    const elTop = $("dicePoolVinTop");
    const elBottom = $("dicePoolVin");
    if (!diceRead) return;

    try {
      if (elTop) elTop.textContent = "Loading...";
      if (elBottom) elBottom.textContent = "Loading...";

      const poolBN = await diceRead.bankroll();
      const poolStr = ethers.utils.formatUnits(poolBN, VIN_DECIMALS);
      const display = `${Number(poolStr).toFixed(4)} VIN`;

      if (elTop) elTop.textContent = display;
      if (elBottom) elBottom.textContent = display;
    } catch (err) {
      console.error("Error loading bankroll:", err);
      if (elTop) elTop.textContent = "N/A";
      if (elBottom) elBottom.textContent = "N/A";
    }
  }

  function updateDicePlayerInfo() {
    if (!currentAccount) {
      setText("diceWalletAddressShort", "Not connected");
      setText("diceVinBalance", "-");
      setText("diceMonBalance", "-");
      return;
    }
    setText("diceWalletAddressShort", shortenHex(currentAccount));
    setText("diceVinBalance", `${formatVin(vinBalanceBN)} VIN`);
    setText("diceMonBalance", `${formatMon(monBalanceBN)} MON`);
  }

  // ===== Wallet & network =====
  async function connectWallet() {
    if (!window.ethereum) {
      alert("MetaMask (or compatible wallet) is not installed.");
      return;
    }

    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });

      web3Provider = new ethers.providers.Web3Provider(window.ethereum, "any");
      signer = web3Provider.getSigner();

      const network = await web3Provider.getNetwork();
      if (network.chainId !== MONAD_CHAIN_ID_DEC) {
        setNetworkDot("wrong");
        setText("networkName", `Wrong network (chainId ${network.chainId})`);
        setText("networkNameHome", `Wrong network (chainId ${network.chainId})`);

        try {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: MONAD_CHAIN_ID_HEX }]
          });
        } catch (switchError) {
          console.warn("User did not switch network:", switchError);
          alert("Please switch MetaMask to Monad Mainnet (chainId 143).");
          return;
        }
      }

      const accounts = await web3Provider.listAccounts();
      if (!accounts || accounts.length === 0) {
        throw new Error("No accounts");
      }

      currentAccount = accounts[0];

      vinWrite = new ethers.Contract(VIN_TOKEN_ADDRESS, VIN_TOKEN_ABI, signer);
      swapWrite = new ethers.Contract(SWAP_CONTRACT_ADDRESS, SWAP_CONTRACT_ABI, signer);
      diceWrite = new ethers.Contract(DICE_CONTRACT_ADDRESS, DICE_CONTRACT_ABI, signer);

      setText("walletAddressShort", shortenHex(currentAccount));
      setText("networkName", "Connected (Monad)");
      setText("networkNameHome", "Connected (Monad)");
      setNetworkDot("ok");
      const btn = $("connectButton");
      if (btn) btn.textContent = "Connected";

      await refreshBalances();
      await refreshDicePool();

      setupWalletEventListeners();
    } catch (err) {
      console.error("Error connecting wallet:", err);
      alert("Failed to connect wallet. See console for details.");
    }
  }

  function setupWalletEventListeners() {
    if (!window.ethereum) return;

    if (window.ethereum.removeAllListeners) {
      window.ethereum.removeAllListeners("accountsChanged");
      window.ethereum.removeAllListeners("chainChanged");
    }

    window.ethereum.on("accountsChanged", async (accounts) => {
      if (!accounts || accounts.length === 0) {
        currentAccount = null;
        signer = null;
        vinWrite = null;
        swapWrite = null;
        diceWrite = null;

        setText("walletAddressShort", "Not connected");
        setText("vinBalance", "-");
        setText("monBalance", "-");
        setText("networkName", "Not connected");
        setText("networkNameHome", "Not connected");
        setNetworkDot("disconnected");
        const btn = $("connectButton");
        if (btn) btn.textContent = "Connect Wallet";

        setText("diceWalletAddressShort", "Not connected");
        setText("diceVinBalance", "-");
        setText("diceMonBalance", "-");
        return;
      }

      currentAccount = accounts[0];
      web3Provider = new ethers.providers.Web3Provider(window.ethereum, "any");
      signer = web3Provider.getSigner();
      vinWrite = new ethers.Contract(VIN_TOKEN_ADDRESS, VIN_TOKEN_ABI, signer);
      swapWrite = new ethers.Contract(SWAP_CONTRACT_ADDRESS, SWAP_CONTRACT_ABI, signer);
      diceWrite = new ethers.Contract(DICE_CONTRACT_ADDRESS, DICE_CONTRACT_ABI, signer);

      setText("walletAddressShort", shortenHex(currentAccount));
      await refreshBalances();
      await refreshDicePool();
    });

    window.ethereum.on("chainChanged", async (chainIdHex) => {
      const chainIdDec = parseInt(chainIdHex, 16);
      if (chainIdDec !== MONAD_CHAIN_ID_DEC) {
        setNetworkDot("wrong");
        setText("networkName", `Wrong network (chainId ${chainIdDec})`);
        setText("networkNameHome", `Wrong network (chainId ${chainIdDec})`);
      } else {
        setNetworkDot("ok");
        setText("networkName", "Connected (Monad)");
        setText("networkNameHome", "Connected (Monad)");
      }

      web3Provider = new ethers.providers.Web3Provider(window.ethereum, "any");
      signer = web3Provider.getSigner();
      vinWrite = new ethers.Contract(VIN_TOKEN_ADDRESS, VIN_TOKEN_ABI, signer);
      swapWrite = new ethers.Contract(SWAP_CONTRACT_ADDRESS, SWAP_CONTRACT_ABI, signer);
      diceWrite = new ethers.Contract(DICE_CONTRACT_ADDRESS, DICE_CONTRACT_ABI, signer);

      await refreshBalances();
      await refreshDicePool();
    });
  }

  // ===== Balances =====
  async function refreshBalances() {
    if (!currentAccount || !web3Provider || !vinRead) {
      setText("vinBalance", "-");
      setText("monBalance", "-");
      setText("fromBalanceLabel", "Balance: -");
      setText("toBalanceLabel", "Balance: -");
      updateDicePlayerInfo();
      return;
    }

    try {
      vinBalanceBN = await vinRead.balanceOf(currentAccount);
      monBalanceBN = await web3Provider.getBalance(currentAccount);

      setText("vinBalance", formatVin(vinBalanceBN));
      setText("monBalance", formatMon(monBalanceBN));

      updateSwapBalanceLabels();
      updateDicePlayerInfo();
    } catch (err) {
      console.error("Error refreshing balances:", err);
      setText("vinBalance", "-");
      setText("monBalance", "-");
      setText("fromBalanceLabel", "Balance: -");
      setText("toBalanceLabel", "Balance: -");
    }
  }

  function updateSwapBalanceLabels() {
    let fromLabel = "Balance: -";
    let toLabel = "Balance: -";

    if (swapDirection === "vin-to-mon") {
      fromLabel = `Balance: ${formatVin(vinBalanceBN)} VIN`;
      toLabel = `Balance: ${formatMon(monBalanceBN)} MON`;
    } else {
      fromLabel = `Balance: ${formatMon(monBalanceBN)} MON`;
      toLabel = `Balance: ${formatVin(vinBalanceBN)} VIN`;
    }

    setText("fromBalanceLabel", fromLabel);
    setText("toBalanceLabel", toLabel);
  }

  // ===== Swap logic =====
  function setSwapDirection(direction) {
    swapDirection = direction;

    const tabVinToMon = $("tabVinToMon");
    const tabMonToVin = $("tabMonToVin");
    const fromToken = $("swapFromToken");
    const toToken = $("swapToToken");

    if (direction === "vin-to-mon") {
      if (tabVinToMon) tabVinToMon.classList.add("active");
      if (tabMonToVin) tabMonToVin.classList.remove("active");
      if (fromToken) fromToken.textContent = "VIN";
      if (toToken) toToken.textContent = "MON";
    } else {
      if (tabVinToMon) tabVinToMon.classList.remove("active");
      if (tabMonToVin) tabMonToVin.classList.add("active");
      if (fromToken) fromToken.textContent = "MON";
      if (toToken) toToken.textContent = "VIN";
    }

    updateSwapBalanceLabels();
    onSwapAmountInput();
  }

  function onSwapAmountInput() {
    const fromInput = $("swapFromAmount");
    const toAmountEl = $("swapToAmount");
    const rateLabel = $("swapRateLabel");
    if (!fromInput) return;

    const raw = fromInput.value.trim();
    if (!raw || Number(raw) <= 0) {
      if (toAmountEl) toAmountEl.value = "";
      if (rateLabel) rateLabel.textContent = "1 VIN = 1 MON";
      setText("swapStatus", "Ready to swap.");
      return;
    }

    // Fixed 1:1
    if (toAmountEl) {
      toAmountEl.value = raw;
    }

    if (rateLabel) rateLabel.textContent = "Fixed rate: 1 VIN = 1 MON";
  }

  function onSwapMax() {
    const fromInput = $("swapFromAmount");
    if (!fromInput) return;

    if (swapDirection === "vin-to-mon") {
      fromInput.value = vinBalanceBN
        ? ethers.utils.formatUnits(vinBalanceBN, VIN_DECIMALS)
        : "";
    } else {
      fromInput.value = monBalanceBN ? ethers.utils.formatEther(monBalanceBN) : "";
    }
    onSwapAmountInput();
  }

  async function onSwapAction() {
    if (!currentAccount || !signer || !vinWrite || !swapWrite) {
      alert("Please connect your wallet first.");
      return;
    }

    const fromInput = $("swapFromAmount");
    const statusEl = $("swapStatus");
    if (!fromInput) return;

    const raw = fromInput.value.trim();
    if (!raw || Number(raw) <= 0) {
      alert("Please enter a valid amount.");
      return;
    }

    try {
      if (swapDirection === "vin-to-mon") {
        const amountBN = ethers.utils.parseUnits(raw, VIN_DECIMALS);

        if (vinBalanceBN && vinBalanceBN.lt(amountBN)) {
          alert("Not enough VIN balance.");
          if (statusEl) statusEl.textContent = "Not enough VIN balance.";
          return;
        }

        // Check allowance
        const allowance = await vinRead.allowance(currentAccount, SWAP_CONTRACT_ADDRESS);
        if (allowance.lt(amountBN)) {
          if (statusEl) statusEl.textContent = "Sending VIN approval for Swap...";
          const txApprove = await vinWrite.approve(SWAP_CONTRACT_ADDRESS, amountBN);
          const receiptApprove = await txApprove.wait();
          if (!receiptApprove || receiptApprove.status !== 1) {
            throw new Error("Approve transaction for Swap reverted on-chain.");
          }
        }

        if (statusEl) statusEl.textContent = "Swapping VIN for MON...";
        const tx = await swapWrite.swapVinForMon(amountBN);
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error("Swap VIN→MON transaction reverted on-chain.");
        }

        if (statusEl) statusEl.textContent = "Swap VIN → MON completed.";
      } else {
        const amountBN = ethers.utils.parseEther(raw);

        if (monBalanceBN && monBalanceBN.lt(amountBN)) {
          alert("Not enough MON balance.");
          if (statusEl) statusEl.textContent = "Not enough MON balance.";
          return;
        }

        if (statusEl) statusEl.textContent = "Swapping MON for VIN...";
        const tx = await swapWrite.swapMonForVin({ value: amountBN });
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error("Swap MON→VIN transaction reverted on-chain.");
        }

        if (statusEl) statusEl.textContent = "Swap MON → VIN completed.";
      }

      await refreshBalances();
      await refreshDicePool();
      onSwapAmountInput();
    } catch (err) {
      console.error("Swap error:", err);
      if (statusEl) statusEl.textContent = "Swap failed. See console for details.";
      alert("Swap failed. Please check console for details.");
    }
  }

  // ===== Dice visual helpers (orb + 4 coins) =====
  function getDiceCoins() {
    const visual = $("diceVisual");
    if (!visual) return [];
    return Array.from(visual.querySelectorAll(".dice-coin"));
  }

  function setDiceCoinsPattern(pattern) {
    // pattern: array of length 4, true = red, false = white
    const coins = getDiceCoins();
    for (let i = 0; i < coins.length && i < pattern.length; i++) {
      const coin = coins[i];
      const isRed = !!pattern[i];
      coin.classList.remove("dice-coin-white", "dice-coin-red");
      coin.classList.add(isRed ? "dice-coin-red" : "dice-coin-white");
      coin.style.transform = "translate(0, 0)";
    }
  }

  function setDiceVisualNeutral() {
    // Default neutral: 2 white + 2 red
    setDiceCoinsPattern([false, false, true, true]);
    const visual = $("diceVisual");
    if (visual) {
      visual.classList.remove("dice-shaking");
    }
  }

  function setDiceVisualFromResult(resultEven) {
    // Choose a random pattern with correct parity:
    // Even: 4 white / 4 red / 2 red 2 white
    // Odd : 3 red 1 white / 1 red 3 white
    let patterns;
    if (resultEven) {
      patterns = [
        [false, false, false, false], // 4 white
        [true, true, true, true],     // 4 red
        [false, false, true, true]    // 2 white 2 red
      ];
    } else {
      patterns = [
        [true, true, true, false],    // 3 red, 1 white
        [true, false, false, false]   // 1 red, 3 white
      ];
    }
    const idx = Math.floor(Math.random() * patterns.length);
    setDiceCoinsPattern(patterns[idx]);
  }

  function startDiceShake() {
    const visual = $("diceVisual");
    if (visual) {
      visual.classList.add("dice-shaking");
    }
  }

  function stopDiceShake() {
    const visual = $("diceVisual");
    if (visual) {
      visual.classList.remove("dice-shaking");
    }
  }

  // ===== Dice helpers =====
  function setGuess(isEven) {
    currentGuessEven = !!isEven;
    const btnEven = $("guessEvenButton");
    const btnOdd = $("guessOddButton");

    if (currentGuessEven) {
      if (btnEven) btnEven.classList.add("active");
      if (btnOdd) btnOdd.classList.remove("active");
    } else {
      if (btnEven) btnEven.classList.remove("active");
      if (btnOdd) btnOdd.classList.add("active");
    }
  }

  function diceMax() {
    const input = $("diceBetAmount");
    if (!input) return;
    input.value = vinBalanceBN
      ? ethers.utils.formatUnits(vinBalanceBN, VIN_DECIMALS)
      : "";
  }

  function diceRepeat() {
    const input = $("diceBetAmount");
    if (!input) return;
    if (!lastBetAmountBN) {
      alert("No previous bet to repeat.");
      return;
    }
    input.value = ethers.utils.formatUnits(lastBetAmountBN, VIN_DECIMALS);
  }

  function diceHalf() {
    const input = $("diceBetAmount");
    if (!input) return;
    const raw = input.value.trim();
    const val = Number(raw);
    if (!raw || val <= 0) return;
    input.value = (val / 2).toString();
  }

  function diceDouble() {
    const input = $("diceBetAmount");
    if (!input) return;
    const raw = input.value.trim();
    const val = Number(raw);
    if (!raw || val <= 0) return;
    input.value = (val * 2).toString();
  }

  function diceClear() {
    const input = $("diceBetAmount");
    if (!input) return;
    input.value = "";
  }

  function updateDiceVisualFromLastGame() {
    if (!lastDiceGame) {
      setDiceVisualNeutral();
      return;
    }
    setDiceVisualFromResult(!!lastDiceGame.resultEven);
  }

  function updateDiceLastResultUI() {
    if (!lastDiceGame) {
      setText("diceLastResult", "-");
      setText("diceLastOutcome", "-");
      setText("diceLastWinLoss", "-");
      setText("diceLastPayout", "-");
      setText("diceLastTx", "-");
      setDiceVisualNeutral();
      return;
    }

    setText("diceLastResult", lastDiceGame.resultEven ? "Even" : "Odd");
    setText(
      "diceLastOutcome",
      lastDiceGame.guessEven ? "You guessed Even" : "You guessed Odd"
    );
    setText("diceLastWinLoss", lastDiceGame.win ? "Win" : "Lose");
    setText("diceLastPayout", lastDiceGame.payoutVin);
    setText(
      "diceLastTx",
      lastDiceGame.txHash ? shortenHex(lastDiceGame.txHash) : "-"
    );

    // Update orb visual to match result (4 quân vị đúng chẵn / lẻ)
    updateDiceVisualFromLastGame();
  }

  function onDiceRefreshLast() {
    if (!lastDiceGame) {
      alert("No game played in this session yet.");
      return;
    }
    updateDiceLastResultUI();
  }

  // ===== Dice Approve =====
  async function onDiceApprove() {
    if (!currentAccount || !signer || !vinWrite || !diceWrite || !diceRead) {
      alert("Please connect your wallet first.");
      return;
    }

    const statusEl = $("diceStatus");

    try {
      const approveAmountBN = ethers.utils.parseUnits(
        DICE_APPROVE_VIN_STRING,
        VIN_DECIMALS
      );

      // Check current allowance
      const currentAllowance = await vinRead.allowance(
        currentAccount,
        DICE_CONTRACT_ADDRESS
      );
      if (currentAllowance.gte(approveAmountBN)) {
        if (statusEl)
          statusEl.textContent =
            "VIN is already approved for Dice for this amount or more.";
        alert("VIN is already approved for Dice.");
        return;
      }

      if (statusEl) statusEl.textContent = "Sending VIN approval for Dice...";
      const tx = await vinWrite.approve(DICE_CONTRACT_ADDRESS, approveAmountBN);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error("Approve transaction for Dice reverted on-chain.");
      }

      if (statusEl) statusEl.textContent = "VIN approve for Dice completed.";
      alert("Approve VIN for Dice completed.");
    } catch (err) {
      console.error("Dice approve error:", err);
      if (statusEl)
        statusEl.textContent =
          "Approve VIN for Dice failed. See console for details.";
      alert("Approve VIN for Dice failed. Please check console for details.");
    }
  }

  // ===== Dice Play =====
  async function onDicePlay() {
    if (!currentAccount || !signer || !vinWrite || !diceWrite || !diceRead) {
      alert("Please connect your wallet first.");
      return;
    }

    const input = $("diceBetAmount");
    const statusEl = $("diceStatus");
    if (!input) return;

    const raw = input.value.trim();
    if (!raw || Number(raw) <= 0) {
      alert("Please enter a valid bet amount.");
      return;
    }

    try {
      if (statusEl) statusEl.textContent = "Preparing dice game...";

      const amountBN = ethers.utils.parseUnits(raw, VIN_DECIMALS);
      lastBetAmountBN = amountBN;

      if (vinBalanceBN && vinBalanceBN.lt(amountBN)) {
        const balanceStr = formatVin(vinBalanceBN);
        const msg = `Not enough VIN balance. Your balance: ${balanceStr} VIN.`;
        alert(msg);
        if (statusEl) statusEl.textContent = msg;
        return;
      }

      const minBetBN = await diceRead.MIN_BET();
      if (amountBN.lt(minBetBN)) {
        const minBetStr = ethers.utils.formatUnits(minBetBN, VIN_DECIMALS);
        const msg = `Bet must be at least ${Number(minBetStr).toFixed(
          4
        )} VIN.`;
        alert(msg);
        if (statusEl) statusEl.textContent = msg;
        return;
      }

      const bankBN = await diceRead.bankroll();
      const neededBN = amountBN.mul(2);
      if (bankBN.lt(neededBN)) {
        const bankStr = ethers.utils.formatUnits(bankBN, VIN_DECIMALS);
        const neededStr = ethers.utils.formatUnits(neededBN, VIN_DECIMALS);
        const msg = `Dice reward pool is too low. Bankroll: ${Number(
          bankStr
        ).toFixed(4)} VIN, requires at least ${Number(neededStr).toFixed(
          4
        )} VIN (2× bet).`;
        alert(msg);
        if (statusEl) statusEl.textContent = msg;
        return;
      }

      // Check allowance - DO NOT auto-approve here, require user click Approve button
      const allowance = await vinRead.allowance(currentAccount, DICE_CONTRACT_ADDRESS);
      if (allowance.lt(amountBN)) {
        const msg =
          "VIN is not approved for Dice or allowance is too low. Please click 'Approve VIN for Dice' first.";
        alert(msg);
        if (statusEl) statusEl.textContent = msg;
        return;
      }

      // Start "shaking" orb while waiting for on-chain result
      startDiceShake();
      if (statusEl) statusEl.textContent = "Sending Dice transaction...";

      const tx = await diceWrite.play(amountBN, currentGuessEven);
      if (statusEl) statusEl.textContent = "Waiting for confirmation...";

      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw Object.assign(
          new Error("Dice transaction reverted on-chain."),
          { code: "CALL_EXCEPTION", receipt }
        );
      }

      if (statusEl)
        statusEl.textContent = "Dice transaction confirmed. Updating result...";

      const iface = diceWrite.interface;
      let playedEvent = null;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed && parsed.name === "Played") {
            playedEvent = parsed;
            break;
          }
        } catch {
          // ignore logs from other contracts
        }
      }

      if (playedEvent) {
        const { player, amount, guessEven, resultEven, win } = playedEvent.args;
        const amountVinStr = Number(
          ethers.utils.formatUnits(amount, VIN_DECIMALS)
        ).toFixed(4);
        const payoutVinStr = win
          ? (Number(amountVinStr) * 2).toFixed(4)
          : "0.0000";

        lastDiceGame = {
          player,
          amountVin: `${amountVinStr} VIN`,
          guessEven,
          resultEven,
          win,
          payoutVin: `${payoutVinStr} VIN`,
          txHash: receipt.transactionHash
        };

        updateDiceLastResultUI();
      } else {
        console.warn("No Played event found in Dice transaction logs.");
        // Even if no event parsed, stop shaking
        setDiceVisualNeutral();
      }

      await refreshBalances();
      await refreshDicePool();

      if (statusEl) statusEl.textContent = "Dice game completed.";
    } catch (err) {
      console.error("Dice play error:", err);

      let msg = "Dice game failed. Please check console for details.";
      if (err && err.code === "CALL_EXCEPTION") {
        msg = "Dice game reverted on-chain (CALL_EXCEPTION).";
      }

      if (statusEl) statusEl.textContent = msg;
      alert(msg);
    } finally {
      // Dù thắng hay lỗi cũng dừng hiệu ứng rung
      stopDiceShake();
    }
  }

  // ===== Init app =====
  function initApp() {
    if (typeof ethers === "undefined") {
      console.error("Ethers.js library is not loaded.");
      alert(
        "Ethers.js library is not loaded. Please check your internet connection or the script tag."
      );
      return;
    }

    initReadProvider();
    setGuess(true);
    showScreen("home-screen");
    setSwapDirection("vin-to-mon");
    setNetworkDot("disconnected");
    updateDicePlayerInfo();
    setDiceVisualNeutral();

    // Nav
    const navHome = $("navHome");
    const navSwap = $("navSwap");
    const navDice = $("navDice");
    if (navHome) navHome.addEventListener("click", goHome);
    if (navSwap) navSwap.addEventListener("click", goSwap);
    if (navDice) navDice.addEventListener("click", goDice);

    // Home buttons
    const goToSwapBtn = $("goToSwap");
    const goToDiceBtn = $("goToDice");
    if (goToSwapBtn) goToSwapBtn.addEventListener("click", goSwap);
    if (goToDiceBtn) goToDiceBtn.addEventListener("click", goDice);

    // Connect wallet
    const connectBtn = $("connectButton");
    if (connectBtn) connectBtn.addEventListener("click", connectWallet);

    const refreshBtn = $("refreshBalances");
    if (refreshBtn) refreshBtn.addEventListener("click", refreshBalances);

    // Swap
    const tabVinToMon = $("tabVinToMon");
    const tabMonToVin = $("tabMonToVin");
    if (tabVinToMon)
      tabVinToMon.addEventListener("click", () => setSwapDirection("vin-to-mon"));
    if (tabMonToVin)
      tabMonToVin.addEventListener("click", () => setSwapDirection("mon-to-vin"));

    const swapFromAmount = $("swapFromAmount");
    const swapMaxButton = $("swapMaxButton");
    if (swapFromAmount)
      swapFromAmount.addEventListener("input", onSwapAmountInput);
    if (swapMaxButton) swapMaxButton.addEventListener("click", onSwapMax);

    const swapActionButton = $("swapActionButton");
    if (swapActionButton)
      swapActionButton.addEventListener("click", onSwapAction);

    // Dice guess
    const guessEvenBtn = $("guessEvenButton");
    const guessOddBtn = $("guessOddButton");
    if (guessEvenBtn) guessEvenBtn.addEventListener("click", () => setGuess(true));
    if (guessOddBtn) guessOddBtn.addEventListener("click", () => setGuess(false));

    // Dice tools
    const diceMaxBtn = $("diceMaxButton");
    const diceRepeatBtn = $("diceRepeatButton");
    const diceHalfBtn = $("diceHalfButton");
    const diceDoubleBtn = $("diceDoubleButton");
    const diceClearBtn = $("diceClearButton");
    if (diceMaxBtn) diceMaxBtn.addEventListener("click", diceMax);
    if (diceRepeatBtn) diceRepeatBtn.addEventListener("click", diceRepeat);
    if (diceHalfBtn) diceHalfBtn.addEventListener("click", diceHalf);
    if (diceDoubleBtn) diceDoubleBtn.addEventListener("click", diceDouble);
    if (diceClearBtn) diceClearBtn.addEventListener("click", diceClear);

    // Dice approve & play
    const diceApproveBtn = $("diceApproveButton");
    if (diceApproveBtn) diceApproveBtn.addEventListener("click", onDiceApprove);

    const dicePlayBtn = $("dicePlayButton");
    if (dicePlayBtn) dicePlayBtn.addEventListener("click", onDicePlay);

    const diceRefreshLastBtn = $("diceRefreshLast");
    if (diceRefreshLastBtn)
      diceRefreshLastBtn.addEventListener("click", onDiceRefreshLast);
  }

  document.addEventListener("DOMContentLoaded", initApp);
})();
