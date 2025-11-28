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

  // ===== Minimal ABIs (human readable) =====
  // Only the functions we actually use in the dApp
  const VIN_TOKEN_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)"
  ];

  const SWAP_CONTRACT_ABI = [
    // MON -> VIN (send MON native with value)
    "function swapMonForVin() payable",
    // VIN -> MON (requires approve first)
    "function swapVinForMon(uint256 vinAmount)"
  ];

  const DICE_CONTRACT_ABI = [
    "function MIN_BET() view returns (uint256)",
    "function bankroll() view returns (uint256)",
    "function play(uint256 amount, bool guessEven)",
    "event Played(address indexed player, uint256 amount, bool guessEven, bool resultEven, bool win)"
  ];

  // ===== Global state =====
  let readProvider = null;     // JsonRpcProvider (read-only)
  let web3Provider = null;     // Web3Provider from MetaMask
  let signer = null;
  let currentAccount = null;

  let vinRead = null;
  let vinWrite = null;
  let swapRead = null;
  let swapWrite = null;
  let diceRead = null;
  let diceWrite = null;

  let vinBalanceBN = null; // BigNumber VIN balance
  let monBalanceBN = null; // BigNumber MON (native) balance

  // Swap direction: 'vin-to-mon' or 'mon-to-vin'
  let swapDirection = "vin-to-mon";

  // Dice state
  let currentGuessEven = true;    // true = Even, false = Odd
  let lastBetAmountBN = null;     // last bet (for Repeat/Half/Double)
  let lastDiceGame = null;        // last game result in this session

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
      // MON native also uses 18 decimals
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

  // ===== Screens & navigation =====
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

  // ===== Init read-only provider =====
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

    // Load Dice info without wallet
    loadMinBet();
    refreshDicePool();
  }

  // ===== Load MIN_BET and bankroll of Dice =====
  async function loadMinBet() {
    const el = $("diceMinInfo");
    if (!diceRead || !el) return;

    try {
      el.textContent = "Loading minimum bet...";
      const minBetBN = await diceRead.MIN_BET();
      const minBetStr = ethers.utils.formatUnits(minBetBN, VIN_DECIMALS);
      el.textContent = `Minimum bet: ${Number(minBetStr).toFixed(4)} VIN`;
    } catch (err) {
      console.error("Error loading min bet:", err);
      el.textContent = "Min bet: failed to load, please try again.";
    }
  }

  async function refreshDicePool() {
    const el = $("dicePoolVin");
    const elTop = $("dicePoolVinTop");
    if (!diceRead || !el) return;

    try {
      el.textContent = "Loading...";
      if (elTop) elTop.textContent = "Loading...";
      const poolBN = await diceRead.bankroll();
      const poolStr = ethers.utils.formatUnits(poolBN, VIN_DECIMALS);
      const display = `${Number(poolStr).toFixed(4)} VIN`;
      el.textContent = display;
      if (elTop) elTop.textContent = display;
    } catch (err) {
      console.error("Error loading bankroll:", err);
      el.textContent = "N/A";
      if (elTop) elTop.textContent = "N/A";
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

      // Init write contracts with signer
      vinWrite = new ethers.Contract(VIN_TOKEN_ADDRESS, VIN_TOKEN_ABI, signer);
      swapWrite = new ethers.Contract(SWAP_CONTRACT_ADDRESS, SWAP_CONTRACT_ABI, signer);
      diceWrite = new ethers.Contract(DICE_CONTRACT_ADDRESS, DICE_CONTRACT_ABI, signer);

      // Update UI
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

    // Remove old listeners if any
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
      // VIN balance (ERC20)
      vinBalanceBN = await vinRead.balanceOf(currentAccount);
      setText("vinBalance", formatVin(vinBalanceBN));

      // MON native balance
      monBalanceBN = await web3Provider.getBalance(currentAccount);
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
    const toTokenEl = $("swapToToken");
    const toAmountEl = $("swapToAmount");
    if (!fromInput) return;

    const raw = fromInput.value.trim();
    if (!raw || Number(raw) <= 0) {
      if (toAmountEl) toAmountEl.value = "";
      setText("swapStatus", "");
      return;
    }

    // Fixed 1:1 VIN <-> MON
    if (toAmountEl) {
      toAmountEl.value = raw;
    }

    if (toTokenEl && toTokenEl.textContent === "MON") {
      setText("swapStatus", "You will receive the same amount of MON (1:1).");
    } else if (toTokenEl && toTokenEl.textContent === "VIN") {
      setText("swapStatus", "You will receive the same amount of VIN (1:1).");
    }
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
    if (!fromInput) return;

    const raw = fromInput.value.trim();
    if (!raw || Number(raw) <= 0) {
      alert("Please enter a valid amount.");
      return;
    }

    const statusEl = $("swapStatus");
    try {
      if (swapDirection === "vin-to-mon") {
        // VIN -> MON
        const amountBN = ethers.utils.parseUnits(raw, VIN_DECIMALS);

        // Check VIN balance
        if (vinBalanceBN && vinBalanceBN.lt(amountBN)) {
          alert("Not enough VIN balance.");
          return;
        }

        // Check allowance VIN -> Swap contract
        const allowance = await vinRead.allowance(currentAccount, SWAP_CONTRACT_ADDRESS);
        if (allowance.lt(amountBN)) {
          if (statusEl) statusEl.textContent = "Sending approval transaction for VIN...";
          const txApprove = await vinWrite.approve(SWAP_CONTRACT_ADDRESS, amountBN);
          await txApprove.wait();
        }

        if (statusEl) statusEl.textContent = "Swapping VIN for MON...";
        const tx = await swapWrite.swapVinForMon(amountBN);
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error("Swap VIN->MON transaction reverted on-chain.");
        }

        if (statusEl) statusEl.textContent = "Swap VIN → MON completed.";
      } else {
        // MON -> VIN
        const amountBN = ethers.utils.parseEther(raw);

        if (monBalanceBN && monBalanceBN.lt(amountBN)) {
          alert("Not enough MON balance to pay.");
          return;
        }

        if (statusEl) statusEl.textContent = "Swapping MON for VIN...";
        const tx = await swapWrite.swapMonForVin({ value: amountBN });
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error("Swap MON->VIN transaction reverted on-chain.");
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

  function updateDiceLastResultUI() {
    if (!lastDiceGame) {
      setText("diceLastResult", "-");
      setText("diceLastOutcome", "-");
      setText("diceLastWinLoss", "-");
      setText("diceLastPayout", "-");
      setText("diceLastTx", "-");
      return;
    }

    setText("diceLastResult", lastDiceGame.resultEven ? "Even" : "Odd");
    setText(
      "diceLastOutcome",
      lastDiceGame.guessEven ? "You guessed Even" : "You guessed Odd"
    );
    setText("diceLastWinLoss", lastDiceGame.win ? "Win" : "Lose");
    setText("diceLastPayout", lastDiceGame.payoutVin);
    if (lastDiceGame.txHash) {
      setText("diceLastTx", shortenHex(lastDiceGame.txHash));
    } else {
      setText("diceLastTx", "-");
    }
  }

  // ===== Dice main action =====
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

      // Convert VIN amount to smallest units
      const amountBN = ethers.utils.parseUnits(raw, VIN_DECIMALS);
      lastBetAmountBN = amountBN;

      // 1) Check VIN balance
      if (vinBalanceBN && vinBalanceBN.lt(amountBN)) {
        alert("Not enough VIN balance.");
        if (statusEl) statusEl.textContent = "Not enough VIN balance.";
        return;
      }

      // 2) Check MIN_BET from Dice contract
      const minBetBN = await diceRead.MIN_BET();
      if (amountBN.lt(minBetBN)) {
        const minBetStr = ethers.utils.formatUnits(minBetBN, VIN_DECIMALS);
        alert(`Bet must be at least ${Number(minBetStr).toFixed(4)} VIN.`);
        if (statusEl) {
          statusEl.textContent = `Bet too small. Minimum is ${Number(
            minBetStr
          ).toFixed(4)} VIN.`;
        }
        return;
      }

      // 3) Check Dice bankroll >= 2 * bet (VIN has no transfer fee)
      const bankBN = await diceRead.bankroll();
      const neededBN = amountBN.mul(2);
      if (bankBN.lt(neededBN)) {
        const bankStr = ethers.utils.formatUnits(bankBN, VIN_DECIMALS);
        const neededStr = ethers.utils.formatUnits(neededBN, VIN_DECIMALS);
        const msg = `Dice reward pool is too low. Bankroll: ${Number(
          bankStr
        ).toFixed(4)} VIN, but needs at least ${Number(neededStr).toFixed(
          4
        )} VIN (2x your bet).`;
        alert(msg);
        if (statusEl) statusEl.textContent = msg;
        return;
      }

      // 4) Check VIN allowance for Dice contract
      const allowance = await vinRead.allowance(currentAccount, DICE_CONTRACT_ADDRESS);
      if (allowance.lt(amountBN)) {
        if (statusEl) {
          statusEl.textContent = "Sending approval transaction for VIN to Dice...";
        }
        const txApprove = await vinWrite.approve(DICE_CONTRACT_ADDRESS, amountBN);
        const receiptApprove = await txApprove.wait();
        if (!receiptApprove || receiptApprove.status !== 1) {
          throw new Error("Approve transaction reverted on-chain.");
        }
      }

      // 5) Send Dice transaction
      if (statusEl) statusEl.textContent = "Sending Dice transaction...";
      const tx = await diceWrite.play(amountBN, currentGuessEven);
      if (statusEl) statusEl.textContent = "Waiting for confirmation...";
      const receipt = await tx.wait();

      if (!receipt || receipt.status !== 1) {
        // If status = 0, the contract reverted (CALL_EXCEPTION)
        throw Object.assign(new Error("Dice transaction reverted on-chain."), {
          code: "CALL_EXCEPTION",
          receipt
        });
      }

      if (statusEl) {
        statusEl.textContent = "Dice transaction confirmed. Updating result...";
      }

      // 6) Parse Played event from logs
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
          // Ignore logs that don't belong to Dice
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
          amountVin: amountVinStr + " VIN",
          guessEven,
          resultEven,
          win,
          payoutVin: payoutVinStr + " VIN",
          txHash: receipt.transactionHash
        };

        updateDiceLastResultUI();
      } else {
        console.warn("No Played event found in transaction logs.");
      }

      await refreshBalances();
      await refreshDicePool();

      if (statusEl) statusEl.textContent = "Dice game completed.";
    } catch (err) {
      console.error("Dice play error:", err);

      let msg = "Dice game failed. Please check console for details.";

      if (err && err.code === "CALL_EXCEPTION") {
        msg = "Dice game reverted on-chain (CALL_EXCEPTION).";
      } else if (
        err &&
        err.code === "UNPREDICTABLE_GAS_LIMIT" &&
        err.error &&
        err.error.data &&
        typeof err.error.data.message === "string" &&
        err.error.data.message.includes("BANK_NOT_ENOUGH")
      ) {
        msg =
          "Dice failed: BANK_NOT_ENOUGH – the Dice contract bankroll is not enough VIN.";
      }

      if (statusEl) statusEl.textContent = msg;
      alert(msg);
    }
  }

  function onDiceRefreshLast() {
    if (!lastDiceGame) {
      alert("No game played in this session yet.");
      return;
    }
    updateDiceLastResultUI();
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
    setGuess(true); // default: Even
    showScreen("home-screen");
    setSwapDirection("vin-to-mon");
    setNetworkDot("disconnected");
    updateDicePlayerInfo();

    // Nav buttons
    const navHome = $("navHome");
    const navSwap = $("navSwap");
    const navDice = $("navDice");
    if (navHome) navHome.addEventListener("click", goHome);
    if (navSwap) navSwap.addEventListener("click", goSwap);
    if (navDice) navDice.addEventListener("click", goDice);

    // Home screen buttons
    const goToSwapBtn = $("goToSwap");
    const goToDiceBtn = $("goToDice");
    if (goToSwapBtn) goToSwapBtn.addEventListener("click", goSwap);
    if (goToDiceBtn) goToDiceBtn.addEventListener("click", goDice);

    // Connect Wallet
    const connectBtn = $("connectButton");
    if (connectBtn) connectBtn.addEventListener("click", connectWallet);

    // Refresh balances
    const refreshBtn = $("refreshBalances");
    if (refreshBtn) refreshBtn.addEventListener("click", refreshBalances);

    // Swap tabs
    const tabVinToMon = $("tabVinToMon");
    const tabMonToVin = $("tabMonToVin");
    if (tabVinToMon)
      tabVinToMon.addEventListener("click", () => setSwapDirection("vin-to-mon"));
    if (tabMonToVin)
      tabMonToVin.addEventListener("click", () => setSwapDirection("mon-to-vin"));

    // Swap input & buttons
    const swapFromAmount = $("swapFromAmount");
    const swapMaxButton = $("swapMaxButton");
    if (swapFromAmount)
      swapFromAmount.addEventListener("input", onSwapAmountInput);
    if (swapMaxButton) swapMaxButton.addEventListener("click", onSwapMax);

    const swapActionButton = $("swapActionButton");
    if (swapActionButton)
      swapActionButton.addEventListener("click", onSwapAction);

    // Dice guess buttons
    const guessEvenBtn = $("guessEvenButton");
    const guessOddBtn = $("guessOddButton");
    if (guessEvenBtn) guessEvenBtn.addEventListener("click", () => setGuess(true));
    if (guessOddBtn) guessOddBtn.addEventListener("click", () => setGuess(false));

    // Dice tool buttons
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

    // Dice play & refresh
    const dicePlayBtn = $("dicePlayButton");
    const diceRefreshLastBtn = $("diceRefreshLast");
    if (dicePlayBtn) dicePlayBtn.addEventListener("click", onDicePlay);
    if (diceRefreshLastBtn)
      diceRefreshLastBtn.addEventListener("click", onDiceRefreshLast);
  }

  document.addEventListener("DOMContentLoaded", initApp);
})();
