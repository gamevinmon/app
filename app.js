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

  // Approve 10,000,000 VIN cho Dice để chơi thoải mái
  const DICE_APPROVE_AMOUNT = ethers.utils.parseUnits("10000000", VIN_DECIMALS);

  // ===== Minimal ABIs =====

  // ERC20 (VIN)
  const ERC20_ABI = [
    // balanceOf(address)
    {
      constant: true,
      inputs: [{ name: "owner", type: "address" }],
      name: "balanceOf",
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function"
    },
    // allowance(owner, spender)
    {
      constant: true,
      inputs: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" }
      ],
      name: "allowance",
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function"
    },
    // approve(spender, value)
    {
      constant: false,
      inputs: [
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" }
      ],
      name: "approve",
      outputs: [{ name: "", type: "bool" }],
      stateMutability: "nonpayable",
      type: "function"
    },
    // decimals()
    {
      constant: true,
      inputs: [],
      name: "decimals",
      outputs: [{ name: "", type: "uint8" }],
      stateMutability: "view",
      type: "function"
    },
    // totalSupply()
    {
      constant: true,
      inputs: [],
      name: "totalSupply",
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function"
    }
  ];

  // VinMonSwap
  const SWAP_ABI = [
    // getMonReserve() view returns (uint256)
    {
      inputs: [],
      name: "getMonReserve",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function"
    },
    // getVinReserve() view returns (uint256)
    {
      inputs: [],
      name: "getVinReserve",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function"
    },
    // swapMonForVin() payable
    {
      inputs: [],
      name: "swapMonForVin",
      outputs: [],
      stateMutability: "payable",
      type: "function"
    },
    // swapVinForMon(uint256 vinAmount)
    {
      inputs: [
        {
          internalType: "uint256",
          name: "vinAmount",
          type: "uint256"
        }
      ],
      name: "swapVinForMon",
      outputs: [],
      stateMutability: "nonpayable",
      type: "function"
    },
    // vinToken() view returns (address)
    {
      inputs: [],
      name: "vinToken",
      outputs: [
        {
          internalType: "address",
          name: "",
          type: "address"
        }
      ],
      stateMutability: "view",
      type: "function"
    }
  ];

  // VinMonDice
  const DICE_ABI = [
    // event Played(address indexed player, uint256 amount, bool guessEven, bool resultEven, bool win)
    {
      anonymous: false,
      inputs: [
        {
          indexed: true,
          internalType: "address",
          name: "player",
          type: "address"
        },
        {
          indexed: false,
          internalType: "uint256",
          name: "amount",
          type: "uint256"
        },
        {
          indexed: false,
          internalType: "bool",
          name: "guessEven",
          type: "bool"
        },
        {
          indexed: false,
          internalType: "bool",
          name: "resultEven",
          type: "bool"
        },
        {
          indexed: false,
          internalType: "bool",
          name: "win",
          type: "bool"
        }
      ],
      name: "Played",
      type: "event"
    },
    // MIN_BET() view returns (uint256)
    {
      inputs: [],
      name: "MIN_BET",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function"
    },
    // bankroll() view returns (uint256)
    {
      inputs: [],
      name: "bankroll",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function"
    },
    // play(uint256 amount, bool guessEven)
    {
      inputs: [
        { internalType: "uint256", name: "amount", type: "uint256" },
        { internalType: "bool", name: "guessEven", type: "bool" }
      ],
      name: "play",
      outputs: [],
      stateMutability: "nonpayable",
      type: "function"
    },
    // vin() view returns (address)
    {
      inputs: [],
      name: "vin",
      outputs: [
        { internalType: "contract IERC20", name: "", type: "address" }
      ],
      stateMutability: "view",
      type: "function"
    }
  ];

  const diceIface = new ethers.utils.Interface(DICE_ABI);

  // ===== State =====
  let readProvider = null; // RPC read-only
  let web3Provider = null; // injected by MetaMask
  let signer = null;
  let currentAccount = null;

  let vinRead = null;
  let vinWrite = null;
  let swapRead = null;
  let swapWrite = null;
  let diceRead = null;
  let diceWrite = null;

  let vinBalanceBN = ethers.constants.Zero;
  let monBalanceBN = ethers.constants.Zero;

  let swapDirection = "vinToMon"; // or "monToVin"

  let diceGuessEven = true; // true = Even, false = Odd
  let diceInFlight = false;
  let lastDiceBetBN = null;
  let lastDiceGame = null; // {player, amountVin, guessEven, resultEven, win, payoutVin, txHash}

  // ===== Helpers =====
  const $ = (id) => document.getElementById(id);

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  function setNetworkStatus(connected, nameText) {
    const dot = $("networkDot");
    if (dot) {
      dot.classList.remove("dot-connected", "dot-disconnected");
      dot.classList.add(connected ? "dot-connected" : "dot-disconnected");
    }
    setText("networkName", connected ? nameText : "Not connected");
    setText("networkNameHome", connected ? nameText : "Not connected");
  }

  function shortAddress(addr) {
    if (!addr) return "";
    return addr.slice(0, 6) + "..." + addr.slice(-4);
  }

  function formatVin(bn, fractionDigits = 4) {
    try {
      const num = parseFloat(ethers.utils.formatUnits(bn || 0, VIN_DECIMALS));
      if (!isFinite(num)) return "-";
      return num.toLocaleString("en-US", {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits
      });
    } catch {
      return "-";
    }
  }

  function formatMon(bn, fractionDigits = 4) {
    try {
      const num = parseFloat(ethers.utils.formatEther(bn || 0));
      if (!isFinite(num)) return "-";
      return num.toLocaleString("en-US", {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits
      });
    } catch {
      return "-";
    }
  }

  function parseVinInput(raw) {
    if (!raw) return null;
    const cleaned = raw.replace(/,/g, "").trim();
    if (!cleaned) return null;
    try {
      return ethers.utils.parseUnits(cleaned, VIN_DECIMALS);
    } catch {
      return null;
    }
  }

  function showScreen(screenId) {
    const screens = ["home-screen", "swap-screen", "dice-screen"];
    screens.forEach((id) => {
      const el = $(id);
      if (!el) return;
      if (id === screenId) {
        el.classList.add("screen-active");
      } else {
        el.classList.remove("screen-active");
      }
    });

    // update nav active class
    const navMap = {
      "home-screen": "navHome",
      "swap-screen": "navSwap",
      "dice-screen": "navDice"
    };
    Object.entries(navMap).forEach(([scr, navId]) => {
      const navEl = $(navId);
      if (!navEl) return;
      if (scr === screenId) {
        navEl.classList.add("nav-link-active");
      } else {
        navEl.classList.remove("nav-link-active");
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

  // Dice visual patterns
  const EVEN_PATTERNS = [
    ["white", "white", "white", "white"], // 0 đỏ
    ["white", "white", "red", "red"],     // 2 đỏ
    ["white", "red", "white", "red"],
    ["red", "red", "white", "white"],
    ["red", "red", "red", "red"]          // 4 đỏ
  ];

  const ODD_PATTERNS = [
    ["white", "white", "white", "red"],   // 1 đỏ
    ["white", "white", "red", "white"],
    ["white", "red", "red", "white"],     // 2 trắng, 2 đỏ nhưng lẻ đỏ/trắng?
    ["red", "red", "red", "white"],       // 3 đỏ
    ["white", "red", "red", "red"]
  ];

  function setDiceCoinsPattern(pattern) {
    const visual = $("diceVisual");
    if (!visual) return;
    const coins = visual.querySelectorAll(".dice-coin");
    if (!coins || coins.length === 0) return;

    for (let i = 0; i < coins.length; i++) {
      const coin = coins[i];
      const color = pattern[i] || "white";
      coin.classList.remove("dice-coin-white", "dice-coin-red");
      coin.classList.add(color === "red" ? "dice-coin-red" : "dice-coin-white");
    }
  }

  function updateDiceVisualForParity(isEven) {
    const patterns = isEven ? EVEN_PATTERNS : ODD_PATTERNS;
    const idx = Math.floor(Math.random() * patterns.length);
    const pattern = patterns[idx];
    setDiceCoinsPattern(pattern);
  }

  function startDiceShaking() {
    const visual = $("diceVisual");
    if (visual) {
      visual.classList.add("dice-shaking");
    }
  }

  function stopDiceShaking() {
    const visual = $("diceVisual");
    if (visual) {
      visual.classList.remove("dice-shaking");
    }
  }

  // ===== Init read-only provider & contracts =====
  function initReadProvider() {
    if (!readProvider) {
      readProvider = new ethers.providers.JsonRpcProvider(RPC_URL);
      vinRead = new ethers.Contract(VIN_TOKEN_ADDRESS, ERC20_ABI, readProvider);
      swapRead = new ethers.Contract(
        SWAP_CONTRACT_ADDRESS,
        SWAP_ABI,
        readProvider
      );
      diceRead = new ethers.Contract(
        DICE_CONTRACT_ADDRESS,
        DICE_ABI,
        readProvider
      );
    }
  }

  // ===== Wallet & connection =====
  async function connectWallet() {
    if (typeof window.ethereum === "undefined") {
      alert("MetaMask (hoặc ví Web3 tương thích) chưa được cài. Vui lòng cài trước.");
      return;
    }

    try {
      const accounts = await window.ethereum.request({
        method: "eth_requestAccounts"
      });
      if (!accounts || accounts.length === 0) {
        return;
      }
      currentAccount = ethers.utils.getAddress(accounts[0]);

      web3Provider = new ethers.providers.Web3Provider(window.ethereum);
      signer = web3Provider.getSigner();

      // Kiểm tra network
      const network = await web3Provider.getNetwork();
      if (Number(network.chainId) !== MONAD_CHAIN_ID_DEC) {
        try {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: MONAD_CHAIN_ID_HEX }]
          });
          const nw2 = await web3Provider.getNetwork();
          if (Number(nw2.chainId) !== MONAD_CHAIN_ID_DEC) {
            throw new Error("Wrong network");
          }
          setNetworkStatus(true, "Monad");
        } catch (switchErr) {
          console.error("Network switch error:", switchErr);
          alert(
            "Vui lòng chuyển mạng sang Monad (chainId 143) trong MetaMask rồi thử lại."
          );
          setNetworkStatus(false, "Not connected");
          return;
        }
      } else {
        setNetworkStatus(true, "Monad");
      }

      // Contracts write
      vinWrite = new ethers.Contract(VIN_TOKEN_ADDRESS, ERC20_ABI, signer);
      swapWrite = new ethers.Contract(SWAP_CONTRACT_ADDRESS, SWAP_ABI, signer);
      diceWrite = new ethers.Contract(DICE_CONTRACT_ADDRESS, DICE_ABI, signer);

      // UI
      setText("walletAddressShort", shortAddress(currentAccount));
      setText("diceWalletAddressShort", shortAddress(currentAccount));

      await refreshBalances();
      await updateDiceLimitsAndAllowance();

      // Lắng nghe events của wallet
      if (window.ethereum && !window.ethereum._gameVinMonAttached) {
        window.ethereum.on("accountsChanged", handleAccountsChanged);
        window.ethereum.on("chainChanged", () => {
          // Reload để tránh tình trạng lẫn mạng
          window.location.reload();
        });
        window.ethereum._gameVinMonAttached = true;
      }
    } catch (err) {
      console.error("Connect wallet error:", err);
      alert("Kết nối ví thất bại. Xem chi tiết trong Console (F12).");
    }
  }

  async function handleAccountsChanged(accounts) {
    if (!accounts || accounts.length === 0) {
      currentAccount = null;
      signer = null;
      web3Provider = null;
      vinWrite = null;
      swapWrite = null;
      diceWrite = null;
      setNetworkStatus(false, "Not connected");
      setText("walletAddressShort", "Not connected");
      setText("diceWalletAddressShort", "Not connected");
      setText("vinBalance", "-");
      setText("monBalance", "-");
      setText("diceVinBalance", "-");
      setText("diceMonBalance", "-");
      await updateDiceLimitsAndAllowance();
      return;
    }

    currentAccount = ethers.utils.getAddress(accounts[0]);
    web3Provider = new ethers.providers.Web3Provider(window.ethereum);
    signer = web3Provider.getSigner();
    vinWrite = new ethers.Contract(VIN_TOKEN_ADDRESS, ERC20_ABI, signer);
    swapWrite = new ethers.Contract(SWAP_CONTRACT_ADDRESS, SWAP_ABI, signer);
    diceWrite = new ethers.Contract(DICE_CONTRACT_ADDRESS, DICE_ABI, signer);

    setText("walletAddressShort", shortAddress(currentAccount));
    setText("diceWalletAddressShort", shortAddress(currentAccount));

    const network = await web3Provider.getNetwork();
    if (Number(network.chainId) === MONAD_CHAIN_ID_DEC) {
      setNetworkStatus(true, "Monad");
    } else {
      setNetworkStatus(false, "Wrong network");
    }

    await refreshBalances();
    await updateDiceLimitsAndAllowance();
  }

  // ===== Balances =====
  async function refreshBalances() {
    try {
      initReadProvider();

      if (!currentAccount) {
        setText("vinBalance", "-");
        setText("monBalance", "-");
        setText("fromBalanceLabel", "Balance: -");
        setText("toBalanceLabel", "Balance: -");
        setText("diceVinBalance", "-");
        setText("diceMonBalance", "-");
        await refreshDicePoolOnly();
        return;
      }

      const [vinBal, monBal] = await Promise.all([
        vinRead.balanceOf(currentAccount),
        readProvider.getBalance(currentAccount)
      ]);

      vinBalanceBN = vinBal;
      monBalanceBN = monBal;

      const vinStr = formatVin(vinBal);
      const monStr = formatMon(monBal);

      setText("vinBalance", vinStr + " VIN");
      setText("monBalance", monStr + " MON");
      setText("fromBalanceLabel", `Balance: ${vinStr} VIN`);
      setText("toBalanceLabel", `Balance: ${monStr} MON`);

      setText("diceVinBalance", vinStr + " VIN");
      setText("diceMonBalance", monStr + " MON");

      // Cập nhật nhãn theo hướng swap hiện tại
      updateSwapBalanceLabels();
      await refreshDicePoolOnly();
    } catch (err) {
      console.error("Error refreshing balances:", err);
      setText("vinBalance", "-");
      setText("monBalance", "-");
      setText("diceVinBalance", "-");
      setText("diceMonBalance", "-");
    }
  }

  function updateSwapBalanceLabels() {
    if (!currentAccount) {
      setText("fromBalanceLabel", "Balance: -");
      setText("toBalanceLabel", "Balance: -");
      return;
    }

    const vinStr = formatVin(vinBalanceBN);
    const monStr = formatMon(monBalanceBN);

    if (swapDirection === "vinToMon") {
      setText("fromBalanceLabel", `Balance: ${vinStr} VIN`);
      setText("toBalanceLabel", `Balance: ${monStr} MON`);
    } else {
      setText("fromBalanceLabel", `Balance: ${monStr} MON`);
      setText("toBalanceLabel", `Balance: ${vinStr} VIN`);
    }
  }

  // ===== Swap logic =====
  function setSwapDirection(direction) {
    swapDirection = direction;

    const tabVinToMon = $("tabVinToMon");
    const tabMonToVin = $("tabMonToVin");
    if (tabVinToMon && tabMonToVin) {
      if (direction === "vinToMon") {
        tabVinToMon.classList.add("active");
        tabMonToVin.classList.remove("active");
      } else {
        tabVinToMon.classList.remove("active");
        tabMonToVin.classList.add("active");
      }
    }

    const fromTokenLabel = $("swapFromToken");
    const toTokenLabel = $("swapToToken");
    if (direction === "vinToMon") {
      if (fromTokenLabel) fromTokenLabel.textContent = "VIN";
      if (toTokenLabel) toTokenLabel.textContent = "MON";
    } else {
      if (fromTokenLabel) fromTokenLabel.textContent = "MON";
      if (toTokenLabel) toTokenLabel.textContent = "VIN";
    }

    const fromInput = $("swapFromAmount");
    const toInput = $("swapToAmount");
    if (fromInput && toInput) {
      const raw = fromInput.value.trim();
      if (raw) {
        toInput.value = raw;
      } else {
        toInput.value = "";
      }
    }

    updateSwapBalanceLabels();
    setText("swapRateLabel", "1 VIN = 1 MON");
  }

  function onSwapFromInputChange() {
    const fromInput = $("swapFromAmount");
    const toInput = $("swapToAmount");
    if (!fromInput || !toInput) return;

    const raw = fromInput.value.trim();
    if (!raw) {
      toInput.value = "";
      return;
    }
    // Tỉ lệ 1:1
    toInput.value = raw;
  }

  function onSwapMax() {
    if (!currentAccount) {
      alert("Vui lòng kết nối ví trước.");
      return;
    }
    const fromInput = $("swapFromAmount");
    if (!fromInput) return;

    let amountStr;
    if (swapDirection === "vinToMon") {
      amountStr = formatVin(vinBalanceBN);
    } else {
      amountStr = formatMon(monBalanceBN);
    }
    fromInput.value = amountStr.replace(/,/g, "");
    onSwapFromInputChange();
  }

  async function onSwapAction() {
    if (!currentAccount || !signer || !swapWrite || !vinWrite || !vinRead) {
      alert("Vui lòng kết nối ví trước.");
      return;
    }

    const fromInput = $("swapFromAmount");
    const statusEl = $("swapStatus");
    if (!fromInput) return;

    const raw = fromInput.value.trim();
    if (!raw || Number(raw) <= 0) {
      alert("Vui lòng nhập số lượng hợp lệ.");
      return;
    }

    if (statusEl) statusEl.textContent = "Sending transaction...";

    try {
      if (swapDirection === "vinToMon") {
        const amountBN = parseVinInput(raw);
        if (!amountBN) {
          alert("Giá trị VIN không hợp lệ.");
          if (statusEl) statusEl.textContent = "Invalid amount.";
          return;
        }

        // Kiểm tra số dư VIN
        if (vinBalanceBN.lt(amountBN)) {
          alert("Không đủ VIN trong ví.");
          if (statusEl) statusEl.textContent = "Insufficient VIN balance.";
          return;
        }

        // Kiểm tra allowance
        const allowance = await vinRead.allowance(
          currentAccount,
          SWAP_CONTRACT_ADDRESS
        );
        if (allowance.lt(amountBN)) {
          if (statusEl) statusEl.textContent =
            "Approving VIN for swap (one moment)...";
          const approveTx = await vinWrite.approve(
            SWAP_CONTRACT_ADDRESS,
            amountBN
          );
          await approveTx.wait();
        }

        if (statusEl) statusEl.textContent = "Swapping VIN → MON...";

        const tx = await swapWrite.swapVinForMon(amountBN);
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error(
            "Swap transaction reverted on-chain (VIN → MON)."
          );
        }
        if (statusEl) statusEl.textContent = "Swap completed (VIN → MON)!";
      } else {
        // MON -> VIN
        const amountBN = ethers.utils.parseEther(
          raw.replace(/,/g, "").trim()
        );
        if (amountBN.lte(0)) {
          alert("Giá trị MON không hợp lệ.");
          if (statusEl) statusEl.textContent = "Invalid amount.";
          return;
        }

        if (monBalanceBN.lt(amountBN)) {
          alert("Không đủ MON trong ví.");
          if (statusEl) statusEl.textContent = "Insufficient MON balance.";
          return;
        }

        if (statusEl) statusEl.textContent = "Swapping MON → VIN...";
        const tx = await swapWrite.swapMonForVin({
          value: amountBN
        });
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error(
            "Swap transaction reverted on-chain (MON → VIN)."
          );
        }
        if (statusEl) statusEl.textContent = "Swap completed (MON → VIN)!";
      }

      await refreshBalances();
    } catch (err) {
      console.error("Swap error:", err);
      if (statusEl) {
        const msg =
          (err && err.message) || "Swap failed. See console for details.";
        statusEl.textContent = msg;
      }
      alert(
        "Swap transaction failed.\n" +
          (err && err.message ? err.message : "Check console (F12).")
      );
    }
  }

  // ===== Dice logic =====
  async function updateDiceLimitsAndAllowance() {
    try {
      initReadProvider();

      const [minBetBN, bankrollBN] = await Promise.all([
        diceRead.MIN_BET(),
        diceRead.bankroll()
      ]);

      const minBetStr = formatVin(minBetBN, 4);
      const poolStr = formatVin(bankrollBN, 4);

      setText("diceMinimumText", `Minimum bet: ${minBetStr} VIN`);
      setText("dicePoolVinTop", poolStr + " VIN");
      setText("dicePoolVin", poolStr + " VIN");

      let allowanceStr = "N/A";
      if (currentAccount && vinRead) {
        const allowanceBN = await vinRead.allowance(
          currentAccount,
          DICE_CONTRACT_ADDRESS
        );
        allowanceStr = formatVin(allowanceBN, 4);
      }

      const infoEl = $("diceMinInfo");
      if (infoEl) {
        if (currentAccount) {
          infoEl.textContent =
            `Min bet: ${minBetStr} VIN. Reward pool: ${poolStr} VIN. ` +
            `Approved allowance left: ${allowanceStr} VIN.`;
        } else {
          infoEl.textContent =
            `Min bet: ${minBetStr} VIN. Reward pool: ${poolStr} VIN. ` +
            `Connect wallet to see your allowance.`;
        }
      }
    } catch (err) {
      console.error("Error updating dice limits/pool:", err);
      setText("diceMinimumText", "Minimum bet: -");
      setText("dicePoolVinTop", "-");
      setText("dicePoolVin", "-");
      const infoEl = $("diceMinInfo");
      if (infoEl) infoEl.textContent = "Unable to load Dice info.";
    }
  }

  async function refreshDicePoolOnly() {
    try {
      initReadProvider();
      const bankrollBN = await diceRead.bankroll();
      const poolStr = formatVin(bankrollBN, 4);
      setText("dicePoolVinTop", poolStr + " VIN");
      setText("dicePoolVin", poolStr + " VIN");
    } catch (err) {
      console.error("Error refreshing dice pool:", err);
    }
  }

  async function onDiceApprove() {
    if (!currentAccount || !signer || !vinWrite) {
      alert("Vui lòng kết nối ví trước.");
      return;
    }
    const statusEl = $("diceStatus");
    try {
      if (statusEl) {
        statusEl.textContent =
          "Sending approve tx (10,000,000 VIN) to Dice contract...";
      }
      const tx = await vinWrite.approve(DICE_CONTRACT_ADDRESS, DICE_APPROVE_AMOUNT);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error("Approve transaction reverted on-chain.");
      }
      if (statusEl) {
        statusEl.textContent =
          "Approve completed. You can now play Dice comfortably.";
      }
      await updateDiceLimitsAndAllowance();
    } catch (err) {
      console.error("Dice approve error:", err);
      if (statusEl) {
        statusEl.textContent =
          "Approve failed: " +
          ((err && err.message) || "See console for details.");
      }
      alert(
        "Dice approve failed.\n" +
          (err && err.message ? err.message : "Check console (F12).")
      );
    }
  }

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
        evenBtn.classList.remove("active");
        oddBtn.classList.add("active");
      }
    }
  }

  function onDiceMax() {
    if (!currentAccount) {
      alert("Vui lòng kết nối ví trước.");
      return;
    }
    const input = $("diceBetAmount");
    if (!input) return;
    const vinStr = formatVin(vinBalanceBN);
    input.value = vinStr.replace(/,/g, "");
  }

  function onDiceRepeat() {
    if (!lastDiceBetBN) return;
    const input = $("diceBetAmount");
    if (!input) return;
    input.value = ethers.utils
      .formatUnits(lastDiceBetBN, VIN_DECIMALS)
      .replace(/,/g, "");
  }

  function onDiceHalf() {
    const input = $("diceBetAmount");
    if (!input) return;
    const raw = input.value.trim();
    if (!raw) return;
    const val = Number(raw.replace(/,/g, ""));
    if (!isFinite(val) || val <= 0) return;
    const half = val / 2;
    input.value = half.toString();
  }

  function onDiceDouble() {
    const input = $("diceBetAmount");
    if (!input) return;
    const raw = input.value.trim();
    if (!raw) return;
    const val = Number(raw.replace(/,/g, ""));
    if (!isFinite(val) || val <= 0) return;
    const dbl = val * 2;
    input.value = dbl.toString();
  }

  function onDiceClear() {
    const input = $("diceBetAmount");
    if (input) input.value = "";
  }

  function updateDiceLastResultUI() {
    const last = lastDiceGame;
    if (!last) {
      setText("diceLastResult", "No local game yet.");
      setText("diceLastOutcome", "-");
      setText("diceLastWinLoss", "-");
      setText("diceLastPayout", "-");
      setText("diceLastTx", "-");
      return;
    }

    setText("diceLastResult", last.guessEven ? "Bet: Even" : "Bet: Odd");
    setText(
      "diceLastOutcome",
      last.resultEven ? "Outcome: Even" : "Outcome: Odd"
    );
    setText("diceLastWinLoss", last.win ? "You WON" : "You lost");
    setText("diceLastPayout", last.payoutVin);

    if (last.txHash) {
      const short = last.txHash.slice(0, 10) + "..." + last.txHash.slice(-6);
      setText("diceLastTx", short);
    }

    // Cập nhật hình 4 quân vị theo kết quả
    updateDiceVisualForParity(last.resultEven);
  }

  async function onDiceRefreshLast() {
    // Hiện tại: chỉ dùng local history (vì không query log toàn chain)
    updateDiceLastResultUI();
  }

  async function onDicePlay() {
    if (!currentAccount || !signer || !vinWrite || !diceWrite || !diceRead) {
      alert("Vui lòng kết nối ví trước.");
      return;
    }
    if (diceInFlight) {
      // Đang chờ tx trước, tránh spam
      return;
    }

    const input = $("diceBetAmount");
    const statusEl = $("diceStatus");
    if (!input) return;

    const raw = input.value.trim();
    if (!raw || Number(raw) <= 0) {
      alert("Vui lòng nhập số VIN muốn cược.");
      return;
    }

    const amountBN = parseVinInput(raw);
    if (!amountBN || amountBN.lte(0)) {
      alert("Giá trị VIN không hợp lệ.");
      return;
    }

    diceInFlight = true;
    startDiceShaking();
    if (statusEl) statusEl.textContent = "Preparing Dice transaction...";

    try {
      initReadProvider();

      // Lấy MIN_BET, bankroll, allowance, balances để tránh CALL_EXCEPTION
      const [minBetBN, bankrollBN, allowanceBN, playerVinBN] = await Promise.all([
        diceRead.MIN_BET(),
        diceRead.bankroll(),
        vinRead.allowance(currentAccount, DICE_CONTRACT_ADDRESS),
        vinRead.balanceOf(currentAccount)
      ]);

      vinBalanceBN = playerVinBN;
      setText("diceVinBalance", formatVin(playerVinBN) + " VIN");

      // Kiểm tra min bet
      if (amountBN.lt(minBetBN)) {
        const minStr = formatVin(minBetBN);
        if (statusEl)
          statusEl.textContent = `Bet too small. Min bet = ${minStr} VIN.`;
        alert(`Số VIN cược phải ≥ ${minStr} VIN.`);
        return;
      }

      // Kiểm tra số dư VIN
      if (playerVinBN.lt(amountBN)) {
        if (statusEl) statusEl.textContent = "Insufficient VIN balance.";
        alert("Không đủ VIN trong ví để cược.");
        return;
      }

      // Kiểm tra bankroll đủ trả 2x
      const neededPayout = amountBN.mul(2);
      if (bankrollBN.lt(neededPayout)) {
        const poolStr = formatVin(bankrollBN);
        if (statusEl)
          statusEl.textContent =
            "Reward pool is too small for this bet. Try lower amount.";
        alert(
          `Bankroll hiện tại không đủ để trả thưởng x2 cho mức cược này.\n` +
            `Reward pool: ${poolStr} VIN.`
        );
        return;
      }

      // Kiểm tra allowance
      if (allowanceBN.lt(amountBN)) {
        const allowStr = formatVin(allowanceBN);
        const needStr = formatVin(amountBN);
        if (statusEl)
          statusEl.textContent =
            `Allowance too low (${allowStr} VIN). ` +
            `Please click "Approve VIN for Dice" first.`;
        alert(
          `Hạn mức approve cho Dice đang thấp (${allowStr} VIN).\n` +
            `Cần ≥ ${needStr} VIN. Vui lòng bấm "Approve VIN for Dice" trước.`
        );
        return;
      }

      lastDiceBetBN = amountBN;
      const guessEven = getCurrentDiceGuessEven();

      if (statusEl)
        statusEl.textContent =
          "Sending Dice transaction... (MetaMask may ask you to confirm)";

      const tx = await diceWrite.play(amountBN, guessEven);
      if (statusEl) statusEl.textContent = "Waiting for Dice transaction receipt...";
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error(
          "Dice game reverted on-chain (CALL_EXCEPTION)."
        );
      }

      // Parse Played event
      let parsed = null;
      for (const log of receipt.logs) {
        try {
          const ev = diceIface.parseLog(log);
          if (ev && ev.name === "Played") {
            parsed = ev;
            break;
          }
        } catch {
          // ignore other contract logs
        }
      }

      if (parsed) {
        const { player, amount, guessEven, resultEven, win } = parsed.args;
        const amountStr = formatVin(amount, 4);
        const payoutBN = amount.mul(2);
        const payoutStr = win ? formatVin(payoutBN, 4) + " VIN" : "0 VIN";

        lastDiceGame = {
          player,
          amountVin: `${amountStr} VIN`,
          guessEven,
          resultEven,
          win,
          payoutVin: payoutStr,
          txHash: receipt.transactionHash
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
      stopDiceShaking();
    }
  }

  // ===== Init & Event bindings =====
  function initApp() {
    if (typeof window.ethers === "undefined") {
      console.error("Ethers.js library is not loaded.");
      alert(
        "Ethers.js library is not loaded. Please check your internet connection."
      );
      return;
    }

    initReadProvider();
    setNetworkStatus(false, "Not connected");
    showScreen("home-screen");

    // Nav
    const navHome = $("navHome");
    const navSwap = $("navSwap");
    const navDice = $("navDice");
    if (navHome) navHome.addEventListener("click", goHome);
    if (navSwap) navSwap.addEventListener("click", goSwap);
    if (navDice) navDice.addEventListener("click", goDice);

    const goToSwapBtn = $("goToSwap");
    const goToDiceBtn = $("goToDice");
    if (goToSwapBtn) goToSwapBtn.addEventListener("click", goSwap);
    if (goToDiceBtn) goToDiceBtn.addEventListener("click", goDice);

    // Connect button
    const connectBtn = $("connectButton");
    if (connectBtn) connectBtn.addEventListener("click", connectWallet);

    // Refresh balances
    const refreshBtn = $("refreshBalances");
    if (refreshBtn) refreshBtn.addEventListener("click", refreshBalances);

    // Swap events
    const tabVinToMon = $("tabVinToMon");
    const tabMonToVin = $("tabMonToVin");
    if (tabVinToMon)
      tabVinToMon.addEventListener("click", () =>
        setSwapDirection("vinToMon")
      );
    if (tabMonToVin)
      tabMonToVin.addEventListener("click", () =>
        setSwapDirection("monToVin")
      );
    const swapFromInput = $("swapFromAmount");
    if (swapFromInput)
      swapFromInput.addEventListener("input", onSwapFromInputChange);
    const swapMaxBtn = $("swapMaxButton");
    if (swapMaxBtn) swapMaxBtn.addEventListener("click", onSwapMax);
    const swapActionBtn = $("swapActionButton");
    if (swapActionBtn) swapActionBtn.addEventListener("click", onSwapAction);

    // Dice events
    const diceApproveBtn = $("diceApproveButton");
    if (diceApproveBtn)
      diceApproveBtn.addEventListener("click", onDiceApprove);

    const dicePlayBtn = $("dicePlayButton");
    if (dicePlayBtn) dicePlayBtn.addEventListener("click", onDicePlay);

    const diceMaxBtn = $("diceMaxButton");
    if (diceMaxBtn) diceMaxBtn.addEventListener("click", onDiceMax);

    const diceRepeatBtn = $("diceRepeatButton");
    if (diceRepeatBtn) diceRepeatBtn.addEventListener("click", onDiceRepeat);

    const diceHalfBtn = $("diceHalfButton");
    if (diceHalfBtn) diceHalfBtn.addEventListener("click", onDiceHalf);

    const diceDoubleBtn = $("diceDoubleButton");
    if (diceDoubleBtn)
      diceDoubleBtn.addEventListener("click", onDiceDouble);

    const diceClearBtn = $("diceClearButton");
    if (diceClearBtn) diceClearBtn.addEventListener("click", onDiceClear);

    const guessEvenBtn = $("guessEvenButton");
    const guessOddBtn = $("guessOddButton");
    if (guessEvenBtn)
      guessEvenBtn.addEventListener("click", () => onGuessButtonClick(true));
    if (guessOddBtn)
      guessOddBtn.addEventListener("click", () => onGuessButtonClick(false));

    const diceRefreshLastBtn = $("diceRefreshLast");
    if (diceRefreshLastBtn)
      diceRefreshLastBtn.addEventListener("click", onDiceRefreshLast);

    // Lần đầu: lấy thông tin Dice (MIN_BET, pool) để hiển thị, và đặt pattern trung tính
    updateDiceLimitsAndAllowance();
    setDiceCoinsPattern(["white", "white", "white", "white"]);
  }

  document.addEventListener("DOMContentLoaded", initApp);
})();
