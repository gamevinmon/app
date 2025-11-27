// app.js – GameVinMon
// Swap MON ↔ VIN (1:1) + VIN Dice (Even / Odd)
// Requirements: MetaMask + Monad network (chainId = 143)
// Uses ethers.js v5.7.2 (already loaded in index.html)

;(function () {
  "use strict";

  // ==========================
  //  Config & Constants
  // ==========================

  const MONAD_CHAIN_ID_HEX = "0x8f"; // 143 decimal
  const MONAD_CHAIN_ID_DEC = 143;

  const RPC_URL = "https://rpc.monad.xyz"; // read-only provider

  // Contract addresses (must match index.html)
  const VIN_TOKEN_ADDRESS =
    "0x09166bFA4a40BAbC19CCCEc6A6154d9c058098EC";
  const SWAP_CONTRACT_ADDRESS =
    "0xCdce3485752E7a7D4323f899FEe152D9F27e890B";
  const DICE_CONTRACT_ADDRESS =
    "0xE9Ed2c2987da0289233A1a1AE24438A314Ad6B2f";

  // VIN has 18 decimals
  const VIN_DECIMALS = 18;

  // Minimum Dice bet (VIN)
  const DICE_MIN_BET_VIN = "0.01";

  // Swap directions
  const DIRECTION_MON_TO_VIN = "MON_TO_VIN";
  const DIRECTION_VIN_TO_MON = "VIN_TO_MON";

  let swapDirection = DIRECTION_MON_TO_VIN;

  // ethers objects (will be initialized in init())
  let ethersLib = null;
  let readProvider = null;
  let provider = null; // Web3Provider from MetaMask
  let signer = null;
  let currentAccount = null;

  // ==========================
  //  ABIs (aligned with on-chain contracts)
  // ==========================

  // Minimal ERC20 ABI
  const ERC20_ABI = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  ];

  // VinMonSwap – fixed 1:1 swap MON ↔ VIN
  const SWAP_ABI = [
    "function getVinReserve() view returns (uint256)",
    "function getMonReserve() view returns (uint256)",
    "function swapMonForVin() payable",
    "function swapVinForMon(uint256 vinAmount)",
  ];

  // VinMonDice – even/odd game for VIN
  const DICE_ABI = [
    "function MIN_BET() view returns (uint256)",
    "function bankroll() view returns (uint256)",
    "function play(uint256 amount, bool guessEven) external",
    "event Played(address indexed player,uint256 amount,bool guessEven,bool resultEven,bool win)",
  ];

  // ==========================
  //  DOM Elements
  // ==========================

  const els = {};

  function cacheDom() {
    // Top nav
    els.networkStatus = document.getElementById("networkStatus");
    els.networkName = document.getElementById("networkName");
    els.connectButton = document.getElementById("connectButton");

    // Info bar
    els.vinPriceUsd = document.getElementById("vinPriceUsd");

    // Views
    els.views = {
      home: document.getElementById("home-view"),
      swap: document.getElementById("swap-view"),
      dice: document.getElementById("dice-view"),
    };

    // Buttons that switch views (data-view="home|swap|dice")
    els.viewButtons = document.querySelectorAll("[data-view]");

    // Token info buttons
    els.copyVinAddress = document.getElementById("copyVinAddress");
    els.addVinToMetamask = document.getElementById("addVinToMetamask");

    // Swap view
    els.fromTokenIcon = document.getElementById("fromTokenIcon");
    els.fromTokenSymbol = document.getElementById("fromTokenSymbol");
    els.toTokenIcon = document.getElementById("toTokenIcon");
    els.toTokenSymbol = document.getElementById("toTokenSymbol");

    els.fromAmount = document.getElementById("fromAmount");
    els.toAmount = document.getElementById("toAmount");
    els.maxFromButton = document.getElementById("maxFromButton");
    els.fromBalance = document.getElementById("fromBalance");
    els.toBalance = document.getElementById("toBalance");

    els.swapRateText = document.getElementById("swapRateText");
    els.switchDirection = document.getElementById("switchDirection");
    els.approveButton = document.getElementById("approveButton");
    els.swapButton = document.getElementById("swapButton");
    els.swapStatus = document.getElementById("swapStatus");

    els.monReserve = document.getElementById("monReserve");
    els.vinReserve = document.getElementById("vinReserve");

    // Dice view
    els.vinBalance = document.getElementById("vinBalance");
    els.diceBankroll = document.getElementById("diceBankroll");
    els.diceAmount = document.getElementById("diceAmount");
    els.minBetText = document.getElementById("minBetText");
    els.betEvenButton = document.getElementById("betEvenButton");
    els.betOddButton = document.getElementById("betOddButton");
    els.diceStatus = document.getElementById("diceStatus");
    els.diceLastResult = document.getElementById("diceLastResult");
  }

  // ==========================
  //  Helpers
  // ==========================

  function formatAddress(addr) {
    if (!addr) return "";
    return addr.slice(0, 6) + "…" + addr.slice(-4);
  }

  function formatAmount(value, decimals = 4) {
    if (value == null || value === "–") return "–";
    const num = Number(value);
    if (!isFinite(num)) return "–";
    if (num === 0) return "0";
    if (num < 10 ** -decimals) return "<" + 10 ** -decimals;
    return num.toFixed(decimals);
  }

  function setStatus(el, msg, isError = false) {
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = isError ? "#b91c1c" : "#6b7280";
  }

  function getVinContract(readOnly = false) {
    const base = readOnly || !signer ? readProvider : signer;
    return new ethersLib.Contract(VIN_TOKEN_ADDRESS, ERC20_ABI, base);
  }

  function getSwapContract(readOnly = false) {
    const base = readOnly || !signer ? readProvider : signer;
    return new ethersLib.Contract(SWAP_CONTRACT_ADDRESS, SWAP_ABI, base);
  }

  function getDiceContract(readOnly = false) {
    const base = readOnly || !signer ? readProvider : signer;
    return new ethersLib.Contract(DICE_CONTRACT_ADDRESS, DICE_ABI, base);
  }

  // ==========================
  //  View Handling
  // ==========================

  function showView(name) {
    if (!els.views) return;
    Object.entries(els.views).forEach(([key, el]) => {
      if (!el) return;
      if (key === name) {
        el.classList.add("active-view");
        el.classList.remove("hidden-view");
      } else {
        el.classList.remove("active-view");
        el.classList.add("hidden-view");
      }
    });
  }

  // ==========================
  //  Wallet & Network
  // ==========================

  async function connectWallet() {
    if (!window.ethereum) {
      alert(
        "MetaMask (or another EVM wallet) is not detected. Please install it first."
      );
      return;
    }

    try {
      provider = new ethersLib.providers.Web3Provider(window.ethereum, "any");
      const accounts = await provider.send("eth_requestAccounts", []);
      signer = provider.getSigner();
      currentAccount = ethersLib.utils.getAddress(accounts[0]);

      if (els.connectButton) {
        els.connectButton.textContent = formatAddress(currentAccount);
      }

      await ensureMonadNetwork();
      await updateNetworkInfo();
      await refreshAllBalances();
    } catch (err) {
      console.error("connectWallet error:", err);
      alert("Failed to connect wallet. Please check the console for details.");
    }
  }

  async function ensureMonadNetwork() {
    if (!provider || !window.ethereum) return;
    const net = await provider.getNetwork();
    if (net.chainId === MONAD_CHAIN_ID_DEC) return;

    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: MONAD_CHAIN_ID_HEX }],
      });
    } catch (switchErr) {
      console.warn("Network switch failed:", switchErr);
      // If Monad is not added to MetaMask yet, user must add it manually.
    }
  }

  async function updateNetworkInfo() {
    if (!els.networkName) return;

    if (!provider) {
      els.networkName.textContent = "Not connected";
      return;
    }
    const net = await provider.getNetwork();
    if (net.chainId === MONAD_CHAIN_ID_DEC) {
      els.networkName.textContent = "Monad";
    } else {
      els.networkName.textContent = `Wrong network (chainId: ${net.chainId})`;
    }
  }

  function attachWalletEvents() {
    if (!window.ethereum) return;

    window.ethereum.on("accountsChanged", async (accounts) => {
      if (!accounts || accounts.length === 0) {
        currentAccount = null;
        signer = null;
        if (els.connectButton) {
          els.connectButton.textContent = "Connect Wallet";
        }
        await refreshAllBalances();
        return;
      }
      currentAccount = ethersLib.utils.getAddress(accounts[0]);
      signer = provider.getSigner();
      if (els.connectButton) {
        els.connectButton.textContent = formatAddress(currentAccount);
      }
      await refreshAllBalances();
    });

    window.ethereum.on("chainChanged", async () => {
      window.location.reload();
    });
  }

  // ==========================
  //  Price: VIN ≈ MON (via CoinGecko)
  // ==========================

  async function loadVinPriceEstimate() {
    if (!els.vinPriceUsd) return;

    try {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=monad&vs_currencies=usd"
      );
      if (!res.ok) throw new Error("Failed to fetch price");
      const data = await res.json();
      const price = data?.monad?.usd;
      if (typeof price === "number") {
        els.vinPriceUsd.textContent = `≈ ${price.toFixed(4)} USD (via MON)`;
      }
    } catch (err) {
      console.warn("loadVinPriceEstimate error:", err);
      // Keep default "– USD" if it fails
    }
  }

  // ==========================
  //  Copy & Add VIN to MetaMask
  // ==========================

  async function copyVinAddress() {
    try {
      await navigator.clipboard.writeText(VIN_TOKEN_ADDRESS);
      alert("VIN contract address copied to clipboard.");
    } catch (err) {
      console.warn("Clipboard error:", err);
      alert(
        "Failed to copy address. Please copy it manually:\n" +
          VIN_TOKEN_ADDRESS
      );
    }
  }

  async function addVinToMetaMask() {
    if (!window.ethereum) {
      alert("MetaMask is required to add VIN as a custom token.");
      return;
    }

    try {
      await window.ethereum.request({
        method: "wallet_watchAsset",
        params: {
          type: "ERC20",
          options: {
            address: VIN_TOKEN_ADDRESS,
            symbol: "VIN",
            decimals: VIN_DECIMALS,
            image: location.origin + "/vinlogo.png",
          },
        },
      });
    } catch (err) {
      console.error("addVinToMetaMask error:", err);
      alert("Failed to add VIN to MetaMask.");
    }
  }

  // ==========================
  //  Swap UI & Logic
  // ==========================

  function updateSwapDirectionUI() {
    if (!els.fromTokenSymbol || !els.toTokenSymbol) return;

    if (swapDirection === DIRECTION_MON_TO_VIN) {
      if (els.fromTokenSymbol) els.fromTokenSymbol.textContent = "MON";
      if (els.fromTokenIcon) {
        els.fromTokenIcon.src = "mon24.png";
        els.fromTokenIcon.alt = "MON";
      }

      if (els.toTokenSymbol) els.toTokenSymbol.textContent = "VIN";
      if (els.toTokenIcon) {
        els.toTokenIcon.src = "vin24.png";
        els.toTokenIcon.alt = "VIN";
      }

      if (els.approveButton) els.approveButton.classList.add("hidden");
      if (els.swapButton) els.swapButton.textContent = "Swap MON → VIN";
      if (els.swapRateText) els.swapRateText.textContent = "1 MON = 1 VIN";
    } else {
      if (els.fromTokenSymbol) els.fromTokenSymbol.textContent = "VIN";
      if (els.fromTokenIcon) {
        els.fromTokenIcon.src = "vin24.png";
        els.fromTokenIcon.alt = "VIN";
      }

      if (els.toTokenSymbol) els.toTokenSymbol.textContent = "MON";
      if (els.toTokenIcon) {
        els.toTokenIcon.src = "mon24.png";
        els.toTokenIcon.alt = "MON";
      }

      if (els.approveButton) els.approveButton.classList.remove("hidden");
      if (els.swapButton) els.swapButton.textContent = "Swap VIN → MON";
      if (els.swapRateText) els.swapRateText.textContent = "1 VIN = 1 MON";
    }

    updateToAmountFromInput();
    refreshSwapSideBalances().catch(console.error);
  }

  function updateToAmountFromInput() {
    if (!els.fromAmount || !els.toAmount) return;

    const val = els.fromAmount.value.trim();
    if (!val) {
      els.toAmount.value = "";
      return;
    }
    // Fixed 1:1 rate → mirror the value
    els.toAmount.value = val;
  }

  async function refreshPoolReserves() {
    if (!els.vinReserve || !els.monReserve) return;

    try {
      const swap = getSwapContract(true);
      const [vinBal, monBal] = await Promise.all([
        swap.getVinReserve(),
        swap.getMonReserve(),
      ]);

      els.vinReserve.textContent = formatAmount(
        ethersLib.utils.formatUnits(vinBal, VIN_DECIMALS),
        4
      );
      els.monReserve.textContent = formatAmount(
        ethersLib.utils.formatEther(monBal),
        4
      );
    } catch (err) {
      console.warn("refreshPoolReserves error:", err);
      els.vinReserve.textContent = "–";
      els.monReserve.textContent = "–";
    }
  }

  async function refreshSwapSideBalances() {
    if (!els.fromBalance || !els.toBalance) return;

    if (!currentAccount || !provider) {
      els.fromBalance.textContent = "–";
      els.toBalance.textContent = "–";
      return;
    }

    try {
      const vin = getVinContract();
      const [monBal, vinBal] = await Promise.all([
        provider.getBalance(currentAccount),
        vin.balanceOf(currentAccount),
      ]);

      const monStr = formatAmount(ethersLib.utils.formatEther(monBal), 4);
      const vinStr = formatAmount(
        ethersLib.utils.formatUnits(vinBal, VIN_DECIMALS),
        4
      );

      if (swapDirection === DIRECTION_MON_TO_VIN) {
        els.fromBalance.textContent = monStr;
        els.toBalance.textContent = vinStr;
      } else {
        els.fromBalance.textContent = vinStr;
        els.toBalance.textContent = monStr;
      }
    } catch (err) {
      console.warn("refreshSwapSideBalances error:", err);
      els.fromBalance.textContent = "–";
      els.toBalance.textContent = "–";
    }
  }

  async function handleMaxFrom() {
    if (!els.fromAmount) return;

    if (!currentAccount || !provider) {
      alert("Please connect your wallet first.");
      return;
    }

    try {
      if (swapDirection === DIRECTION_MON_TO_VIN) {
        // Use ~95% of MON to keep some for gas
        const bal = await provider.getBalance(currentAccount);
        const balEth = parseFloat(ethersLib.utils.formatEther(bal));
        if (!isFinite(balEth) || balEth <= 0) return;
        const max = Math.max(balEth * 0.95, 0).toString();
        els.fromAmount.value = max;
      } else {
        // VIN: use full balance
        const vin = getVinContract();
        const bal = await vin.balanceOf(currentAccount);
        const vinVal = ethersLib.utils.formatUnits(bal, VIN_DECIMALS);
        els.fromAmount.value = vinVal;
      }

      updateToAmountFromInput();
    } catch (err) {
      console.error("handleMaxFrom error:", err);
    }
  }

  async function ensureVinAllowance(spender, requiredAmountBig) {
    if (!currentAccount || !provider) {
      throw new Error("Wallet is not connected.");
    }
    const vin = getVinContract();
    const currentAllowance = await vin.allowance(currentAccount, spender);
    if (currentAllowance.gte(requiredAmountBig)) {
      return;
    }

    const tx = await vin.approve(spender, ethersLib.constants.MaxUint256);
    await tx.wait();
  }

  async function approveForCurrentSwap() {
    try {
      if (!currentAccount || !provider) {
        alert("Please connect your wallet first.");
        return;
      }
      if (swapDirection !== DIRECTION_VIN_TO_MON) return;

      if (!els.fromAmount) return;

      const amountStr = els.fromAmount.value.trim();
      if (!amountStr || Number(amountStr) <= 0) {
        alert("Please enter the amount of VIN you want to swap.");
        return;
      }

      const amountBig = ethersLib.utils.parseUnits(amountStr, VIN_DECIMALS);
      setStatus(els.swapStatus, "Approving VIN for swap…");
      await ensureVinAllowance(SWAP_CONTRACT_ADDRESS, amountBig);
      setStatus(
        els.swapStatus,
        "Approve successful. You can now perform the swap."
      );
    } catch (err) {
      console.error("approveForCurrentSwap error:", err);
      setStatus(
        els.swapStatus,
        "Approve failed or was rejected by the user.",
        true
      );
    }
  }

  async function performSwap() {
    try {
      if (!currentAccount || !provider || !signer) {
        alert("Please connect your wallet first.");
        return;
      }
      if (!els.fromAmount || !els.toAmount) return;

      const amountStr = els.fromAmount.value.trim();
      if (!amountStr || Number(amountStr) <= 0) {
        alert("Please enter a valid amount to swap.");
        return;
      }

      const swap = getSwapContract();
      setStatus(els.swapStatus, "Sending swap transaction…");

      if (swapDirection === DIRECTION_MON_TO_VIN) {
        // MON -> VIN
        const value = ethersLib.utils.parseEther(amountStr);
        const tx = await swap.swapMonForVin({ value });
        await tx.wait();
        setStatus(els.swapStatus, "Swap MON → VIN successful ✅");
      } else {
        // VIN -> MON
        const amountBig = ethersLib.utils.parseUnits(amountStr, VIN_DECIMALS);
        await ensureVinAllowance(SWAP_CONTRACT_ADDRESS, amountBig);

        const tx = await swap.swapVinForMon(amountBig);
        await tx.wait();
        setStatus(els.swapStatus, "Swap VIN → MON successful ✅");
      }

      els.fromAmount.value = "";
      els.toAmount.value = "";

      await Promise.all([
        refreshSwapSideBalances(),
        refreshPoolReserves(),
        refreshVinBalanceOnly(),
      ]);
    } catch (err) {
      console.error("performSwap error:", err);
      setStatus(
        els.swapStatus,
        "Swap transaction failed or was rejected.",
        true
      );
    }
  }

  // ==========================
  //  Dice Logic
  // ==========================

  async function refreshVinBalanceOnly() {
    if (!els.vinBalance) return;

    if (!currentAccount || !provider) {
      els.vinBalance.textContent = "–";
      return;
    }
    try {
      const vin = getVinContract();
      const bal = await vin.balanceOf(currentAccount);
      els.vinBalance.textContent = formatAmount(
        ethersLib.utils.formatUnits(bal, VIN_DECIMALS),
        4
      );
    } catch (err) {
      console.warn("refreshVinBalanceOnly error:", err);
      els.vinBalance.textContent = "–";
    }
  }

  async function refreshDiceBankroll() {
    if (!els.diceBankroll) return;

    try {
      const dice = getDiceContract(true);
      const bal = await dice.bankroll();
      els.diceBankroll.textContent = formatAmount(
        ethersLib.utils.formatUnits(bal, VIN_DECIMALS),
        4
      );
    } catch (err) {
      console.warn("refreshDiceBankroll error:", err);
      els.diceBankroll.textContent = "–";
    }
  }

  async function handleDiceBet(isEven) {
    try {
      if (!currentAccount || !provider || !signer) {
        alert("Please connect your wallet first.");
        return;
      }
      if (!els.diceAmount || !els.diceLastResult) return;

      const amountStr = els.diceAmount.value.trim();
      if (!amountStr || Number(amountStr) <= 0) {
        alert("Please enter the VIN amount you want to bet.");
        return;
      }

      const minBet = parseFloat(DICE_MIN_BET_VIN);
      if (Number(amountStr) < minBet) {
        alert(`Minimum bet is ${DICE_MIN_BET_VIN} VIN.`);
        return;
      }

      const amountBig = ethersLib.utils.parseUnits(
        amountStr,
        VIN_DECIMALS
      );

      // Ensure VIN allowance for Dice
      const vin = getVinContract();
      const allowance = await vin.allowance(
        currentAccount,
        DICE_CONTRACT_ADDRESS
      );
      if (allowance.lt(amountBig)) {
        setStatus(els.diceStatus, "Approving VIN for Dice…");
        const approveTx = await vin.approve(
          DICE_CONTRACT_ADDRESS,
          ethersLib.constants.MaxUint256
        );
        await approveTx.wait();
      }

      const dice = getDiceContract();
      setStatus(els.diceStatus, "Sending bet transaction…");

      // play(uint256 amount, bool guessEven)
      const tx = await dice.play(amountBig, isEven);
      const receipt = await tx.wait();

      let resultText = `Bet ${
        isEven ? "EVEN" : "ODD"
      } with ${amountStr} VIN → confirmed.`;

      // Parse Played event (if available)
      try {
        const iface = new ethersLib.utils.Interface(DICE_ABI);
        for (const log of receipt.logs) {
          try {
            const parsed = iface.parseLog(log);
            if (parsed && parsed.name === "Played") {
              const win = parsed.args.win;
              const resultEven = parsed.args.resultEven;
              const resultStr = resultEven ? "EVEN" : "ODD";
              if (win) {
                resultText = `Result: ${resultStr}. You WON! Payout is 2x your net bet. 🎉`;
              } else {
                resultText = `Result: ${resultStr}. You LOST. Better luck next time.`;
              }
              break;
            }
          } catch (e) {
            // ignore single-log parse failures
          }
        }
      } catch (e) {
        // ignore parsing errors
      }

      setStatus(els.diceStatus, "Bet successful ✅");
      els.diceLastResult.textContent = resultText;

      await Promise.all([
        refreshVinBalanceOnly(),
        refreshDiceBankroll(),
      ]);
    } catch (err) {
      console.error("handleDiceBet error:", err);
      setStatus(
        els.diceStatus,
        "Bet transaction failed or was rejected.",
        true
      );
    }
  }

  // ==========================
  //  Refresh All
  // ==========================

  async function refreshAllBalances() {
    await Promise.all([
      refreshSwapSideBalances(),
      refreshPoolReserves(),
      refreshVinBalanceOnly(),
      refreshDiceBankroll(),
    ]);
  }

  // ==========================
  //  Event Listeners
  // ==========================

  function setupEventListeners() {
    // Connect wallet
    if (els.connectButton) {
      els.connectButton.addEventListener("click", connectWallet);
    }

    // View switching
    if (els.viewButtons && els.viewButtons.length > 0) {
      els.viewButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          const target = btn.getAttribute("data-view");
          if (!target) return;
          showView(target);

          if (target === "swap") {
            refreshSwapSideBalances().catch(console.error);
          } else if (target === "dice") {
            refreshVinBalanceOnly().catch(console.error);
            refreshDiceBankroll().catch(console.error);
          }
        });
      });
    }

    // Copy VIN & add token
    if (els.copyVinAddress) {
      els.copyVinAddress.addEventListener("click", copyVinAddress);
    }
    if (els.addVinToMetamask) {
      els.addVinToMetamask.addEventListener("click", addVinToMetaMask);
    }

    // Swap inputs
    if (els.fromAmount) {
      els.fromAmount.addEventListener("input", updateToAmountFromInput);
    }
    if (els.maxFromButton) {
      els.maxFromButton.addEventListener("click", () => {
        handleMaxFrom().catch(console.error);
      });
    }

    // Swap direction toggle
    if (els.switchDirection) {
      els.switchDirection.addEventListener("click", () => {
        swapDirection =
          swapDirection === DIRECTION_MON_TO_VIN
            ? DIRECTION_VIN_TO_MON
            : DIRECTION_MON_TO_VIN;
        updateSwapDirectionUI();
      });
    }

    // Approve & Swap
    if (els.approveButton) {
      els.approveButton.addEventListener("click", () => {
        approveForCurrentSwap().catch(console.error);
      });
    }
    if (els.swapButton) {
      els.swapButton.addEventListener("click", () => {
        performSwap().catch(console.error);
      });
    }

    // Dice
    if (els.minBetText) {
      els.minBetText.textContent = `${DICE_MIN_BET_VIN} VIN`;
    }
    if (els.betEvenButton) {
      els.betEvenButton.addEventListener("click", () => {
        handleDiceBet(true).catch(console.error);
      });
    }
    if (els.betOddButton) {
      els.betOddButton.addEventListener("click", () => {
        handleDiceBet(false).catch(console.error);
      });
    }
  }

  // ==========================
  //  Init
  // ==========================

  async function init() {
    cacheDom();

    // Ensure ethers.js is available
    if (typeof window.ethers === "undefined") {
      alert(
        "Ethers.js library is not loaded. Please check your internet connection or the ethers.js script tag."
      );
      return;
    }

    // Initialize ethers and read-only provider
    ethersLib = window.ethers;
    readProvider = new ethersLib.providers.JsonRpcProvider(
      RPC_URL,
      MONAD_CHAIN_ID_DEC
    );

    setupEventListeners();
    attachWalletEvents();

    // Initial swap direction
    updateSwapDirectionUI();

    // Price estimate
    loadVinPriceEstimate().catch(console.error);

    // Read-only data
    refreshAllBalances().catch(console.error);

    // If MetaMask is available, try to detect already-connected account
    if (window.ethereum) {
      try {
        provider = new ethersLib.providers.Web3Provider(
          window.ethereum,
          "any"
        );
        const accounts = await provider.listAccounts();
        if (accounts && accounts.length > 0) {
          signer = provider.getSigner();
          currentAccount = ethersLib.utils.getAddress(accounts[0]);
          if (els.connectButton) {
            els.connectButton.textContent = formatAddress(currentAccount);
          }
          await ensureMonadNetwork();
          await updateNetworkInfo();
          await refreshAllBalances();
        } else {
          await updateNetworkInfo();
        }
      } catch (err) {
        console.error("init / MetaMask detection error:", err);
      }
    } else {
      // No ethereum – just show default network text
      await updateNetworkInfo();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
