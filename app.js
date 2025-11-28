// app.js - GameVinMon dApp logic (Swap & Dice)
// Network: Monad (chainId 143)
// VIN token: 0x09166bFA4a40BAbC19CCCEc6A6154d9c058098EC
// Swap:      0xCdce3485752E7a7D4323f899FEe152D9F27e890B
// Dice:      0xE9Ed2c2987da0289233A1a1AE24438A314Ad6B2f

(() => {
  "use strict";

  // ===== Constants =====
  const RPC_URL = "https://rpc.monad.xyz";
  const MONAD_CHAIN_ID_DEC = 143;
  const MONAD_CHAIN_ID_HEX = "0x8f"; // 143 in hex

  const VIN_TOKEN_ADDRESS = "0x09166bFA4a40BAbC19CCCEc6A6154d9c058098EC";
  const SWAP_CONTRACT_ADDRESS = "0xCdce3485752E7a7D4323f899FEe152D9F27e890B";
  const DICE_CONTRACT_ADDRESS = "0xE9Ed2c2987da0289233A1a1AE24438A314Ad6B2f";

  const VIN_DECIMALS = 18;
  const MON_DECIMALS = 18;

  // Approve tối đa cho Dice
  const DICE_APPROVE_AMOUNT = ethers.utils.parseUnits("10000000", VIN_DECIMALS);

  // ===== Minimal ABIs =====

  // ERC20 (VIN)
  const VIN_ABI = [
    {
      constant: true,
      inputs: [{ name: "owner", type: "address" }],
      name: "balanceOf",
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function",
    },
    {
      constant: true,
      inputs: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
      ],
      name: "allowance",
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function",
    },
    {
      constant: false,
      inputs: [
        { name: "spender", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      name: "approve",
      outputs: [{ name: "", type: "bool" }],
      stateMutability: "nonpayable",
      type: "function",
    },
    {
      constant: true,
      inputs: [],
      name: "decimals",
      outputs: [{ name: "", type: "uint8" }],
      stateMutability: "view",
      type: "function",
    },
  ];

  // Swap 1 VIN = 1 MON
  const SWAP_ABI = [
    {
      inputs: [{ internalType: "address", name: "_vinToken", type: "address" }],
      stateMutability: "nonpayable",
      type: "constructor",
    },
    {
      inputs: [],
      name: "swapMonForVin",
      outputs: [],
      stateMutability: "payable",
      type: "function",
    },
    {
      inputs: [{ internalType: "uint256", name: "vinAmount", type: "uint256" }],
      name: "swapVinForMon",
      outputs: [],
      stateMutability: "nonpayable",
      type: "function",
    },
  ];

  // Dice (VinMonDice)
  const DICE_ABI = [
    {
      inputs: [{ internalType: "contract IERC20", name: "_vin", type: "address" }],
      stateMutability: "nonpayable",
      type: "constructor",
    },
    {
      anonymous: false,
      inputs: [
        {
          indexed: true,
          internalType: "address",
          name: "player",
          type: "address",
        },
        {
          indexed: false,
          internalType: "uint256",
          name: "amount",
          type: "uint256",
        },
        {
          indexed: false,
          internalType: "bool",
          name: "guessEven",
          type: "bool",
        },
        {
          indexed: false,
          internalType: "bool",
          name: "resultEven",
          type: "bool",
        },
        {
          indexed: false,
          internalType: "bool",
          name: "win",
          type: "bool",
        },
      ],
      name: "Played",
      type: "event",
    },
    {
      inputs: [],
      name: "MIN_BET",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [],
      name: "bankroll",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [
        { internalType: "uint256", name: "amount", type: "uint256" },
        { internalType: "bool", name: "guessEven", type: "bool" },
      ],
      name: "play",
      outputs: [],
      stateMutability: "nonpayable",
      type: "function",
    },
    {
      inputs: [],
      name: "vin",
      outputs: [
        { internalType: "contract IERC20", name: "", type: "address" },
      ],
      stateMutability: "view",
      type: "function",
    },
  ];

  // ===== Global State =====
  let rpcProvider = null;
  let web3Provider = null;
  let signer = null;
  let currentAccount = null;

  let vinRead = null;
  let vinWrite = null;
  let swapWrite = null;
  let diceRead = null;
  let diceWrite = null;

  let vinBalanceBN = ethers.BigNumber.from(0);
  let monBalanceBN = ethers.BigNumber.from(0);

  let diceMinBetBN = null;
  let diceBankrollBN = ethers.BigNumber.from(0);
  let diceAllowanceBN = ethers.BigNumber.from(0);

  let swapDirection = "vinToMon"; // or "monToVin"

  let diceGuessEven = true;
  let diceInFlight = false;
  let lastDiceBetBN = null;
  let lastDiceGame = null;

  // ===== DOM helpers =====
  const $ = (id) => document.getElementById(id);
  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }
  function shortenAddress(addr) {
    if (!addr) return "-";
    return addr.slice(0, 6) + "..." + addr.slice(-4);
  }

  // ===== Format helpers (có dấu phẩy) =====
  function formatUnitsSafe(value, decimals = 18, precision = 4, grouping = true) {
    try {
      const num = Number(ethers.utils.formatUnits(value || 0, decimals));
      if (!Number.isFinite(num)) return "0";
      if (grouping) {
        return num.toLocaleString("en-US", {
          minimumFractionDigits: precision,
          maximumFractionDigits: precision,
        });
      } else {
        return num.toFixed(precision);
      }
    } catch {
      return "0";
    }
  }

  function formatVinDisplay(bn, precision = 4) {
    return formatUnitsSafe(bn, VIN_DECIMALS, precision, true);
  }
  function formatVinPlain(bn, precision = 4) {
    return formatUnitsSafe(bn, VIN_DECIMALS, precision, false);
  }
  function formatMonDisplay(bn, precision = 4) {
    return formatUnitsSafe(bn, MON_DECIMALS, precision, true);
  }
  function formatMonPlain(bn, precision = 4) {
    return formatUnitsSafe(bn, MON_DECIMALS, precision, false);
  }

  function parseVinInput(str) {
    const s = (str || "").trim().replace(/,/g, "");
    if (!s) return null;
    try {
      return ethers.utils.parseUnits(s, VIN_DECIMALS);
    } catch {
      return null;
    }
  }
  function parseMonInput(str) {
    const s = (str || "").trim().replace(/,/g, "");
    if (!s) return null;
    try {
      return ethers.utils.parseUnits(s, MON_DECIMALS);
    } catch {
      return null;
    }
  }

  function extractRevertReason(err) {
    if (!err) return "";
    if (err.reason) return err.reason;
    if (err.error && err.error.message) return err.error.message;
    if (err.data && typeof err.data === "string") return err.data;
    if (err.message) return err.message;
    return "";
  }

  // ===== Network helpers =====
  function setNetworkStatus(connected, name) {
    const dot = $("networkDot");
    const label = $("networkName");
    const labelHome = $("networkNameHome");

    if (dot) {
      dot.classList.remove("dot-connected", "dot-disconnected");
      dot.classList.add(connected ? "dot-connected" : "dot-disconnected");
    }
    if (label) {
      label.textContent = connected ? name || "Connected" : "Not connected";
    }
    if (labelHome) {
      labelHome.textContent = connected ? name || "Connected" : "Not connected";
    }
  }

  async function ensureMonadNetwork() {
    if (!window.ethereum) return false;
    try {
      const chainIdHex = await window.ethereum.request({
        method: "eth_chainId",
      });
      if (chainIdHex === MONAD_CHAIN_ID_HEX) return true;

      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: MONAD_CHAIN_ID_HEX }],
      });
      return true;
    } catch (err) {
      console.error("ensureMonadNetwork error:", err);
      alert(
        "Vui lòng chọn mạng Monad (chainId 143) trong MetaMask trước khi dùng dApp."
      );
      return false;
    }
  }

  function showScreen(screenId) {
    const screens = ["home-screen", "swap-screen", "dice-screen"];
    screens.forEach((id) => {
      const el = $(id);
      if (!el) return;
      if (id === screenId) el.classList.add("screen-active");
      else el.classList.remove("screen-active");
    });

    const navHome = $("navHome");
    const navSwap = $("navSwap");
    const navDice = $("navDice");
    [navHome, navSwap, navDice].forEach((el) => {
      if (!el) return;
      el.classList.remove("nav-item-active");
    });
    if (screenId === "home-screen" && navHome) navHome.classList.add("nav-item-active");
    if (screenId === "swap-screen" && navSwap) navSwap.classList.add("nav-item-active");
    if (screenId === "dice-screen" && navDice) navDice.classList.add("nav-item-active");
  }

  // ===== Providers & Contracts =====
  function initReadProvider() {
    if (!rpcProvider) {
      rpcProvider = new ethers.providers.JsonRpcProvider(RPC_URL);
    }
    if (!vinRead) {
      vinRead = new ethers.Contract(VIN_TOKEN_ADDRESS, VIN_ABI, rpcProvider);
    }
    if (!diceRead) {
      diceRead = new ethers.Contract(DICE_CONTRACT_ADDRESS, DICE_ABI, rpcProvider);
    }
  }

  function initWriteContracts() {
    if (!web3Provider || !signer) return;
    vinWrite = new ethers.Contract(VIN_TOKEN_ADDRESS, VIN_ABI, signer);
    swapWrite = new ethers.Contract(SWAP_CONTRACT_ADDRESS, SWAP_ABI, signer);
    diceWrite = new ethers.Contract(DICE_CONTRACT_ADDRESS, DICE_ABI, signer);
  }

  // ===== Balances & Pool =====
  async function refreshBalances() {
    try {
      initReadProvider();
      const homeVinLabel = $("vinBalance");
      const homeMonLabel = $("monBalance");
      const diceVinLabel = $("diceVinBalance");
      const diceMonLabel = $("diceMonBalance");

      if (!currentAccount || !web3Provider) {
        vinBalanceBN = ethers.BigNumber.from(0);
        monBalanceBN = ethers.BigNumber.from(0);
        if (homeVinLabel) homeVinLabel.textContent = "- VIN";
        if (homeMonLabel) homeMonLabel.textContent = "- MON";
        if (diceVinLabel) diceVinLabel.textContent = "- VIN";
        if (diceMonLabel) diceMonLabel.textContent = "- MON";
        updateSwapBalanceLabels();
        return;
      }

      const [vinBal, monBal] = await Promise.all([
        vinRead.balanceOf(currentAccount),
        web3Provider.getBalance(currentAccount),
      ]);

      vinBalanceBN = vinBal;
      monBalanceBN = monBal;

      const vinStr = formatVinDisplay(vinBal);
      const monStr = formatMonDisplay(monBal);

      if (homeVinLabel) homeVinLabel.textContent = `${vinStr} VIN`;
      if (homeMonLabel) homeMonLabel.textContent = `${monStr} MON`;
      if (diceVinLabel) diceVinLabel.textContent = `${vinStr} VIN`;
      if (diceMonLabel) diceMonLabel.textContent = `${monStr} MON`;

      updateSwapBalanceLabels();
    } catch (err) {
      console.error("refreshBalances error:", err);
    }
  }

  async function updateDicePool() {
    try {
      initReadProvider();
      const bankroll = await diceRead.bankroll();
      diceBankrollBN = bankroll;

      const poolStr = formatVinDisplay(bankroll);
      setText("globalDicePoolVin", `${poolStr} VIN`);
      setText("dicePoolVinTop", `${poolStr} VIN`);
      setText("dicePoolVin", `${poolStr} VIN`);
    } catch (err) {
      console.error("updateDicePool error:", err);
      setText("globalDicePoolVin", "N/A");
      setText("dicePoolVinTop", "N/A");
      setText("dicePoolVin", "N/A");
    }
  }

  // ===== Swap Logic =====
  function updateSwapDirectionUI() {
    const tabVinToMon = $("tabVinToMon");
    const tabMonToVin = $("tabMonToVin");

    if (tabVinToMon && tabMonToVin) {
      tabVinToMon.classList.remove("swap-tab-active");
      tabMonToVin.classList.remove("swap-tab-active");
      if (swapDirection === "vinToMon") tabVinToMon.classList.add("swap-tab-active");
      else tabMonToVin.classList.add("swap-tab-active");
    }

    const fromToken = $("swapFromToken");
    const toToken = $("swapToToken");
    const rateLabel = $("swapRateLabel");

    if (swapDirection === "vinToMon") {
      if (fromToken) fromToken.textContent = "VIN";
      if (toToken) toToken.textContent = "MON";
    } else {
      if (fromToken) fromToken.textContent = "MON";
      if (toToken) toToken.textContent = "VIN";
    }
    if (rateLabel) {
      rateLabel.textContent = "Rate: 1 VIN = 1 MON (fixed)";
    }

    updateSwapBalanceLabels();
    updateSwapToAmount();
  }

  function setSwapDirection(dir) {
    swapDirection = dir;
    updateSwapDirectionUI();
  }

  function updateSwapBalanceLabels() {
    if (!currentAccount) {
      setText("fromBalanceLabel", "Balance: -");
      setText("toBalanceLabel", "Balance: -");
      return;
    }

    const vinStr = formatVinDisplay(vinBalanceBN);
    const monStr = formatMonDisplay(monBalanceBN);

    if (swapDirection === "vinToMon") {
      setText("fromBalanceLabel", `Balance: ${vinStr} VIN`);
      setText("toBalanceLabel", `Balance: ${monStr} MON`);
    } else {
      setText("fromBalanceLabel", `Balance: ${monStr} MON`);
      setText("toBalanceLabel", `Balance: ${vinStr} VIN`);
    }
  }

  function updateSwapToAmount() {
    const fromInput = $("swapFromAmount");
    const toInput = $("swapToAmount");
    if (!fromInput || !toInput) return;

    const raw = fromInput.value.trim();
    if (!raw) {
      toInput.value = "";
      return;
    }
    toInput.value = raw; // 1:1
  }

  function setSwapMax() {
    const fromInput = $("swapFromAmount");
    if (!fromInput || !currentAccount) return;

    if (swapDirection === "vinToMon") {
      fromInput.value = formatVinPlain(vinBalanceBN, 6);
    } else {
      const gasReserve = ethers.utils.parseUnits("0.002", MON_DECIMALS);
      let usable = monBalanceBN.sub(gasReserve);
      if (usable.lt(0)) usable = ethers.BigNumber.from(0);
      fromInput.value = formatMonPlain(usable, 6);
    }
    updateSwapToAmount();
  }

  async function onSwapAction() {
    if (!window.ethereum) {
      alert("Vui lòng cài đặt MetaMask để sử dụng dApp.");
      return;
    }
    const ok = await ensureMonadNetwork();
    if (!ok) return;

    if (!currentAccount || !web3Provider || !signer) {
      alert("Vui lòng kết nối ví trước.");
      return;
    }

    const statusEl = $("swapStatus");
    const fromInput = $("swapFromAmount");
    if (!fromInput) return;

    const raw = fromInput.value.trim();
    if (!raw) {
      if (statusEl) statusEl.textContent = "Please enter amount.";
      return;
    }

    try {
      initReadProvider();
      initWriteContracts();

      if (swapDirection === "vinToMon") {
        const amountBN = parseVinInput(raw);
        if (!amountBN || amountBN.lte(0)) {
          if (statusEl) statusEl.textContent = "Invalid VIN amount.";
          return;
        }

        if (vinBalanceBN.lt(amountBN)) {
          if (statusEl) statusEl.textContent = "Insufficient VIN balance.";
          alert("Không đủ VIN trong ví.");
          return;
        }

        const allowanceBN = await vinRead.allowance(
          currentAccount,
          SWAP_CONTRACT_ADDRESS
        );
        if (allowanceBN.lt(amountBN)) {
          if (statusEl)
            statusEl.textContent =
              "Approving VIN for Swap (please confirm in MetaMask)...";
          const txApprove = await vinWrite.approve(
            SWAP_CONTRACT_ADDRESS,
            amountBN
          );
          await txApprove.wait();
        }

        if (statusEl)
          statusEl.textContent = "Sending swap VIN→MON transaction...";
        const tx = await swapWrite.swapVinForMon(amountBN);
        const receipt = await tx.wait();
        if (receipt.status !== 1) {
          if (statusEl) statusEl.textContent = "Swap transaction reverted.";
          return;
        }
        if (statusEl) statusEl.textContent = "Swap VIN→MON successful!";
      } else {
        const amountBN = parseMonInput(raw);
        if (!amountBN || amountBN.lte(0)) {
          if (statusEl) statusEl.textContent = "Invalid MON amount.";
          return;
        }
        if (monBalanceBN.lt(amountBN)) {
          if (statusEl) statusEl.textContent = "Insufficient MON balance.";
          alert("Không đủ MON trong ví.");
          return;
        }
        if (statusEl)
          statusEl.textContent = "Sending swap MON→VIN transaction...";
        const tx = await swapWrite.swapMonForVin({ value: amountBN });
        const receipt = await tx.wait();
        if (receipt.status !== 1) {
          if (statusEl) statusEl.textContent = "Swap transaction reverted.";
          return;
        }
        if (statusEl) statusEl.textContent = "Swap MON→VIN successful!";
      }

      await refreshBalances();
      await updateDicePool();
    } catch (err) {
      console.error("Swap error:", err);
      const statusEl2 = $("swapStatus");
      if (statusEl2) {
        statusEl2.textContent =
          (err && err.message) || "Swap failed. See console for details.";
      }
      alert(
        "Swap failed.\n" +
          (err && err.message ? err.message : "Check console (F12).")
      );
    }
  }

  // ===== Dice Visual =====
  function setDiceShaking(shaking) {
    const visual = $("diceVisual");
    if (!visual) return;
    if (shaking) visual.classList.add("dice-shaking");
    else visual.classList.remove("dice-shaking");
  }

  function setDiceCoinsPattern(resultEven) {
    const visual = $("diceVisual");
    if (!visual) return;
    const coins = visual.querySelectorAll(".dice-coin");
    if (!coins || coins.length < 4) return;

    const evenPatterns = [
      ["white", "white", "white", "white"],
      ["white", "red", "red", "white"],
      ["red", "white", "white", "red"],
    ];
    const oddPatterns = [
      ["red", "white", "white", "white"],
      ["white", "red", "white", "white"],
      ["red", "red", "red", "white"],
    ];

    const patterns = resultEven ? evenPatterns : oddPatterns;
    const pattern = patterns[Math.floor(Math.random() * patterns.length)];

    for (let i = 0; i < 4; i++) {
      const c = coins[i];
      c.classList.remove("dice-coin-white", "dice-coin-red");
      if (pattern[i] === "red") c.classList.add("dice-coin-red");
      else c.classList.add("dice-coin-white");
    }
  }

  // ===== Dice Logic =====
  function getCurrentDiceGuessEven() {
    return diceGuessEven;
  }

  function onGuessButtonClick(isEven) {
    diceGuessEven = isEven;
    const evenBtn = $("guessEvenButton");
    const oddBtn = $("guessOddButton");
    if (evenBtn && oddBtn) {
      if (isEven) {
        evenBtn.classList.add("active");
        oddBtn.classList.remove("active");
      } else {
        oddBtn.classList.add("active");
        evenBtn.classList.remove("active");
      }
    }
  }

  function updateDiceLastResultUI() {
    const resEl = $("diceLastResult");
    const outcomeEl = $("diceLastOutcome");
    const winLossEl = $("diceLastWinLoss");
    const payoutEl = $("diceLastPayout");
    const txEl = $("diceLastTx");

    if (!lastDiceGame) {
      if (resEl) resEl.textContent = "Last roll: -";
      if (outcomeEl) outcomeEl.textContent = "Outcome: -";
      if (winLossEl) winLossEl.textContent = "You: -";
      if (payoutEl) payoutEl.textContent = "Payout: -";
      if (txEl) txEl.textContent = "Tx Hash: -";
      return;
    }

    const { amountVin, guessEven, resultEven, win, payoutVin, txHash } =
      lastDiceGame;

    const betStr = guessEven ? "Even" : "Odd";
    const outcomeStr = resultEven ? "Even" : "Odd";

    if (resEl)
      resEl.textContent = `Last roll: Bet: ${betStr}, Amount: ${amountVin}`;
    if (outcomeEl) outcomeEl.textContent = `Outcome: ${outcomeStr}`;
    if (winLossEl) winLossEl.textContent = win ? "You: WON" : "You: lost";
    if (payoutEl) payoutEl.textContent = `Payout: ${payoutVin}`;
    if (txEl) {
      const shortTx = txHash
        ? txHash.slice(0, 10) + "..." + txHash.slice(-6)
        : "-";
      txEl.textContent = `Tx Hash: ${shortTx}`;
    }

    setDiceCoinsPattern(resultEven);
  }

  async function updateDiceLimitsAndAllowance() {
    try {
      initReadProvider();
      const minBet = await diceRead.MIN_BET();
      diceMinBetBN = minBet;

      const minBetStr = formatVinDisplay(minBet);
      setText("diceMinInfo", `Min bet: ${minBetStr} VIN (x2 payout on win)`);

      await updateDicePool();

      if (currentAccount) {
        const allowance = await vinRead.allowance(
          currentAccount,
          DICE_CONTRACT_ADDRESS
        );
        diceAllowanceBN = allowance;
        const allowanceStr = formatVinDisplay(allowance);
        setText("diceAllowance", `${allowanceStr} VIN`);
      } else {
        diceAllowanceBN = ethers.BigNumber.from(0);
        setText("diceAllowance", "- VIN");
      }

      const minText = $("diceMinimumText");
      if (minText) minText.textContent = `Minimum: ${minBetStr} VIN`;
    } catch (err) {
      console.error("updateDiceLimitsAndAllowance error:", err);
    }
  }

  async function onDiceApprove() {
    if (!window.ethereum) {
      alert("Vui lòng cài MetaMask để dùng Dice.");
      return;
    }
    const ok = await ensureMonadNetwork();
    if (!ok) return;

    if (!currentAccount || !web3Provider || !signer) {
      alert("Vui lòng kết nối ví trước.");
      return;
    }

    try {
      initWriteContracts();
      const statusEl = $("diceStatus");
      if (statusEl)
        statusEl.textContent =
          "Approving VIN for Dice (please confirm in MetaMask)...";

      const tx = await vinWrite.approve(DICE_CONTRACT_ADDRESS, DICE_APPROVE_AMOUNT);
      const receipt = await tx.wait();
      if (receipt.status !== 1) {
        if (statusEl) statusEl.textContent = "Approve transaction reverted.";
        return;
      }

      if (statusEl) statusEl.textContent = "Approve successful.";
      await updateDiceLimitsAndAllowance();
    } catch (err) {
      console.error("Dice approve error:", err);
      const statusEl = $("diceStatus");
      if (statusEl)
        statusEl.textContent =
          (err && err.message) ||
          "Approve failed. See console for details.";
      alert(
        "Approve failed.\n" +
          (err && err.message ? err.message : "Check console (F12).")
      );
    }
  }

  function onDiceQuickButtons(action) {
    const input = $("diceBetAmount");
    if (!input) return;

    if (action === "clear") {
      input.value = "";
      return;
    }

    let currentBN = lastDiceBetBN;
    if (!currentBN || currentBN.lte(0)) {
      const raw = input.value.trim();
      const parsed = parseVinInput(raw);
      if (!parsed || parsed.lte(0)) return;
      currentBN = parsed;
    }

    if (action === "repeat") {
      // giữ nguyên
    } else if (action === "half") {
      currentBN = currentBN.div(2);
    } else if (action === "double") {
      currentBN = currentBN.mul(2);
    }

    lastDiceBetBN = currentBN;
    input.value = formatVinPlain(currentBN, 6);
  }

  async function onDiceRefreshLast() {
    updateDiceLastResultUI();
  }

  // ==== HÀM DICE PLAY ĐÃ SỬA ĐỂ TRÁNH CALL_EXCEPTION NGẪU NHIÊN ====
  async function onDicePlay() {
    if (!window.ethereum) {
      alert("Vui lòng cài MetaMask để dùng Dice.");
      return;
    }
    const ok = await ensureMonadNetwork();
    if (!ok) return;

    if (!currentAccount || !web3Provider || !signer) {
      alert("Vui lòng kết nối ví trước.");
      return;
    }
    if (diceInFlight) return;

    const input = $("diceBetAmount");
    const statusEl = $("diceStatus");
    if (!input) return;

    const raw = input.value.trim();
    const amountBN = parseVinInput(raw);
    if (!amountBN || amountBN.lte(0)) {
      if (statusEl) statusEl.textContent = "Invalid bet amount.";
      return;
    }

    try {
      diceInFlight = true;
      setDiceShaking(true);
      initReadProvider();
      initWriteContracts();

      // Đọc lại minBet, bankroll, allowance, balance
      const [minBetBN, bankrollBN, allowanceBN, playerVinBN] = await Promise.all([
        diceRead.MIN_BET(),
        diceRead.bankroll(),
        vinRead.allowance(currentAccount, DICE_CONTRACT_ADDRESS),
        vinRead.balanceOf(currentAccount),
      ]);

      diceMinBetBN = minBetBN;
      diceBankrollBN = bankrollBN;
      diceAllowanceBN = allowanceBN;
      vinBalanceBN = playerVinBN;
      setText("diceVinBalance", formatVinDisplay(playerVinBN) + " VIN");

      // 1) Check min bet
      if (amountBN.lt(minBetBN)) {
        const minStr = formatVinDisplay(minBetBN);
        if (statusEl)
          statusEl.textContent = `Bet too small. Minimum is ${minStr} VIN.`;
        alert(`Mức cược quá nhỏ. Tối thiểu là ${minStr} VIN.`);
        return;
      }

      // 2) Check balance
      if (playerVinBN.lt(amountBN)) {
        if (statusEl) statusEl.textContent = "Insufficient VIN balance.";
        alert("Không đủ VIN trong ví để cược.");
        return;
      }

      // 3) Check bankroll (ước tính: cần ≥ amount + amount để trả x2)
      const neededPayout = amountBN.mul(2);
      if (bankrollBN.lt(neededPayout)) {
        const poolStr = formatVinDisplay(bankrollBN);
        if (statusEl)
          statusEl.textContent =
            "Reward pool is too small for this bet. Try lower amount.";
        alert(
          `Bankroll hiện tại không đủ để trả thưởng x2 cho mức cược này.\n` +
            `Reward pool: ${poolStr} VIN.`
        );
        return;
      }

      // 4) Check allowance
      if (allowanceBN.lt(amountBN)) {
        const allowStr = formatVinDisplay(allowanceBN);
        const needStr = formatVinDisplay(amountBN);
        if (statusEl)
          statusEl.textContent =
            `Allowance too low (${allowStr} VIN). Please click "Approve VIN for Dice" first.`;
        alert(
          `Hạn mức approve cho Dice đang thấp (${allowStr} VIN).\n` +
            `Cần ≥ ${needStr} VIN. Vui lòng bấm "Approve VIN for Dice" trước.`
        );
        return;
      }

      lastDiceBetBN = amountBN;
      const guessEven = getCurrentDiceGuessEven();

      // 5) estimateGas trước khi gửi TX
      let gasLimit;
      try {
        const gasEstimate = await diceWrite.estimateGas.play(amountBN, guessEven);
        // Thêm buffer 20% cho chắc chắn không out-of-gas
        gasLimit = gasEstimate.mul(120).div(100);
      } catch (err) {
        console.error("Dice estimateGas reverted:", err);
        const reason = extractRevertReason(err);
        if (statusEl)
          statusEl.textContent =
            "This bet would revert on-chain (estimateGas). " + (reason || "");
        alert(
          "Giao dịch Dice sẽ bị revert nên không gửi lên mạng.\n" +
            (reason || "")
        );
        return;
      }

      if (statusEl)
        statusEl.textContent =
          "Sending Dice transaction... (MetaMask may ask you to confirm)";

      const tx = await diceWrite.play(amountBN, guessEven, { gasLimit });

      if (statusEl)
        statusEl.textContent =
          "Waiting for confirmation on-chain... (please wait)";
      const receipt = await tx.wait();

      if (receipt.status !== 1) {
        if (statusEl) {
          statusEl.textContent =
            "Dice transaction reverted on-chain. Check explorer.";
        }
        console.warn("Dice tx status != 1", receipt);
        return;
      }

      // Parse Played event
      let parsedEvent = null;
      const iface = new ethers.utils.Interface(DICE_ABI);
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== DICE_CONTRACT_ADDRESS.toLowerCase()) {
          continue;
        }
        try {
          const parsed = iface.parseLog(log);
          if (parsed.name === "Played") {
            parsedEvent = parsed;
            break;
          }
        } catch {
          // ignore
        }
      }

      if (parsedEvent) {
        const { player, amount, guessEven, resultEven, win } = parsedEvent.args;
        const amountStr = formatVinDisplay(amount, 4);
        const payoutBN = amount.mul(2);
        const payoutStr = win ? formatVinDisplay(payoutBN, 4) + " VIN" : "0 VIN";

        lastDiceGame = {
          player,
          amountVin: `${amountStr} VIN`,
          guessEven,
          resultEven,
          win,
          payoutVin: payoutStr,
          txHash: receipt.transactionHash,
        };

        if (statusEl) {
          statusEl.textContent = win
            ? `You WON! Bet ${amountStr} VIN, received ${payoutStr}.`
            : `You lost this round. Bet ${amountStr} VIN.`;
        }

        updateDiceLastResultUI();
      } else {
        console.warn("No Played event found in Dice transaction logs.");
        if (statusEl)
          statusEl.textContent =
            "Dice transaction confirmed but event not parsed (check explorer).";
      }

      await refreshBalances();
      await updateDiceLimitsAndAllowance();
    } catch (err) {
      console.error("Dice play error:", err);
      const statusEl = $("diceStatus");
      if (statusEl) {
        const msg =
          (err && err.message) || "Dice play failed. See console for details.";
        statusEl.textContent = msg;
      }
      alert(
        "Dice play failed.\n" +
          (err && err.message ? err.message : "Check console (F12).")
      );
    } finally {
      diceInFlight = false;
      setDiceShaking(false);
    }
  }
  // ==== HẾT HÀM DICE PLAY ====

  // ===== Wallet connect =====
  async function connectWallet() {
    if (!window.ethereum) {
      alert("Vui lòng cài đặt MetaMask để dùng dApp.");
      return;
    }

    const ok = await ensureMonadNetwork();
    if (!ok) return;

    try {
      const accounts = await window.ethereum.request({
        method: "eth_requestAccounts",
      });
      if (!accounts || accounts.length === 0) {
        return;
      }
      currentAccount = ethers.utils.getAddress(accounts[0]);

      web3Provider = new ethers.providers.Web3Provider(window.ethereum);
      signer = web3Provider.getSigner();
      initReadProvider();
      initWriteContracts();

      const short = shortenAddress(currentAccount);
      setText("walletAddressShort", short);
      setText("diceWalletAddressShort", short);

      setNetworkStatus(true, "Monad");

      await refreshBalances();
      await updateDiceLimitsAndAllowance();
      await updateDicePool();
    } catch (err) {
      console.error("connectWallet error:", err);
      alert(
        "Không kết nối được ví.\n" +
          (err && err.message ? err.message : "Check console (F12).")
      );
    }
  }

  // ===== Init & Events =====
  function initNav() {
    const navHome = $("navHome");
    const navSwap = $("navSwap");
    const navDice = $("navDice");
    const goToSwap = $("goToSwap");
    const goToDice = $("goToDice");

    if (navHome) navHome.addEventListener("click", () => showScreen("home-screen"));
    if (navSwap) navSwap.addEventListener("click", () => showScreen("swap-screen"));
    if (navDice) navDice.addEventListener("click", () => showScreen("dice-screen"));

    if (goToSwap) goToSwap.addEventListener("click", () => showScreen("swap-screen"));
    if (goToDice) goToDice.addEventListener("click", () => showScreen("dice-screen"));
  }

  function initSwapEvents() {
    const tabVinToMon = $("tabVinToMon");
    const tabMonToVin = $("tabMonToVin");
    const fromInput = $("swapFromAmount");
    const maxBtn = $("swapMaxButton");
    const actionBtn = $("swapActionButton");

    if (tabVinToMon)
      tabVinToMon.addEventListener("click", () => setSwapDirection("vinToMon"));
    if (tabMonToVin)
      tabMonToVin.addEventListener("click", () => setSwapDirection("monToVin"));
    if (fromInput) fromInput.addEventListener("input", () => updateSwapToAmount());
    if (maxBtn) maxBtn.addEventListener("click", setSwapMax);
    if (actionBtn) actionBtn.addEventListener("click", onSwapAction);

    setSwapDirection("vinToMon");
  }

  function initDiceEvents() {
    const approveBtn = $("diceApproveButton");
    const maxBtn = $("diceMaxButton");
    const repeatBtn = $("diceRepeatButton");
    const halfBtn = $("diceHalfButton");
    const doubleBtn = $("diceDoubleButton");
    const clearBtn = $("diceClearButton");
    const evenBtn = $("guessEvenButton");
    const oddBtn = $("guessOddButton");
    const playBtn = $("dicePlayButton");
    const refreshLastBtn = $("diceRefreshLast");

    if (approveBtn) approveBtn.addEventListener("click", onDiceApprove);
    if (maxBtn)
      maxBtn.addEventListener("click", () => {
        const maxByBalance = vinBalanceBN;
        const maxByBankroll = diceBankrollBN.div(2);
        const maxBN =
          maxByBalance.lt(maxByBankroll) ? maxByBalance : maxByBankroll;
        const input = $("diceBetAmount");
        if (input) input.value = formatVinPlain(maxBN, 6);
      });
    if (repeatBtn)
      repeatBtn.addEventListener("click", () => onDiceQuickButtons("repeat"));
    if (halfBtn)
      halfBtn.addEventListener("click", () => onDiceQuickButtons("half"));
    if (doubleBtn)
      doubleBtn.addEventListener("click", () => onDiceQuickButtons("double"));
    if (clearBtn)
      clearBtn.addEventListener("click", () => onDiceQuickButtons("clear"));

    if (evenBtn) evenBtn.addEventListener("click", () => onGuessButtonClick(true));
    if (oddBtn) oddBtn.addEventListener("click", () => onGuessButtonClick(false));

    if (playBtn) playBtn.addEventListener("click", onDicePlay);
    if (refreshLastBtn) refreshLastBtn.addEventListener("click", onDiceRefreshLast);

    onGuessButtonClick(true); // mặc định Even
    setDiceCoinsPattern(true);
  }

  function initWalletEvents() {
    const connectBtn = $("connectButton");
    if (connectBtn) connectBtn.addEventListener("click", connectWallet);

    const refreshBtn = $("refreshBalances");
    if (refreshBtn)
      refreshBtn.addEventListener("click", async () => {
        await refreshBalances();
        await updateDicePool();
      });

    if (window.ethereum) {
      window.ethereum.on("accountsChanged", (accounts) => {
        if (!accounts || accounts.length === 0) {
          currentAccount = null;
          signer = null;
          web3Provider = null;
          setText("walletAddressShort", "-");
          setText("diceWalletAddressShort", "-");
          setNetworkStatus(false, "Not connected");
          refreshBalances();
        } else {
          currentAccount = ethers.utils.getAddress(accounts[0]);
          web3Provider = new ethers.providers.Web3Provider(window.ethereum);
          signer = web3Provider.getSigner();
          initWriteContracts();
          const short = shortenAddress(currentAccount);
          setText("walletAddressShort", short);
          setText("diceWalletAddressShort", short);
          setNetworkStatus(true, "Monad");
          refreshBalances();
          updateDiceLimitsAndAllowance();
        }
      });

      window.ethereum.on("chainChanged", (chainId) => {
        if (chainId !== MONAD_CHAIN_ID_HEX) {
          setNetworkStatus(false, "Wrong network");
        } else {
          setNetworkStatus(true, "Monad");
        }
        window.location.reload();
      });
    }
  }

  async function initApp() {
    try {
      initReadProvider();
      setNetworkStatus(false, "Not connected");
      showScreen("home-screen");

      initNav();
      initSwapEvents();
      initDiceEvents();
      initWalletEvents();

      await updateDicePool();
      updateDiceLastResultUI();
    } catch (err) {
      console.error("initApp error:", err);
    }
  }

  document.addEventListener("DOMContentLoaded", initApp);
})();
