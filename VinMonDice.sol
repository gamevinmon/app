// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

// Optional: some tokens support estimateFee(value) to estimate transfer fees
interface IFeeAware {
    function estimateFee(uint256 value) external view returns (uint256);
}

/**
 * VinMonDice — simple even/odd dice game for VIN on Monad.
 *
 * Rules:
 * - Token: VIN (ERC20) on Monad.
 * - Minimum bet: 0.01 VIN (if token has 18 decimals, this is 1e16 units).
 * - No maximum bet limit; the only limit is the contract bankroll.
 * - Player chooses:
 *      amount    : how many VIN to bet (in smallest units, e.g. wei).
 *      guessEven : true = bet on even, false = bet on odd.
 * - If the player wins, payout = 2x the received amount (net of transfer fee).
 *
 * IMPORTANT:
 * - There is NO owner withdrawal function.
 * - No address (including the deployer) can withdraw VIN directly.
 * - The only way to take VIN out of this contract is to WIN the game.
 */
contract VinMonDice {
    IERC20 public immutable vin;

    // 0.01 VIN if token has 18 decimals
    uint256 public constant MIN_BET = 1e16;

    event Played(
        address indexed player,
        uint256 amount,
        bool guessEven,
        bool resultEven,
        bool win
    );

    constructor(IERC20 _vin) {
        vin = _vin;
    }

    // View current bankroll of the game
    function bankroll() external view returns (uint256) {
        return vin.balanceOf(address(this));
    }

    /**
     * @param amount     Bet size in VIN smallest units (e.g. wei).
     * @param guessEven  true = bet on even, false = bet on odd.
     */
    function play(uint256 amount, bool guessEven) external {
        require(amount >= MIN_BET, "BET_TOO_SMALL");

        // Check allowance first so that static calls get a clear error
        uint256 allowed = vin.allowance(msg.sender, address(this));
        require(allowed >= amount, "ALLOWANCE_TOO_LOW");

        // Handle fee-on-transfer tokens:
        // measure actual received amount instead of trusting "amount"
        uint256 beforeBal = vin.balanceOf(address(this));
        require(vin.transferFrom(msg.sender, address(this), amount), "TRANSFER_IN_FAILED");
        uint256 afterBal = vin.balanceOf(address(this));
        uint256 received = afterBal - beforeBal;

        // Payout is 2x the net received amount
        uint256 payout = received * 2;

        // Try to estimate outgoing fee if the token supports it
        uint256 feeOut = 0;
        try IFeeAware(address(vin)).estimateFee(payout) returns (uint256 f) {
            feeOut = f;
        } catch {
            // If not supported, assume zero extra fee
        }

        // Ensure the contract has enough balance to pay winner + fees
        uint256 bank = vin.balanceOf(address(this));
        require(bank >= payout + feeOut, "BANK_NOT_ENOUGH");

        // Pseudo-randomness based on previous block hash, timestamp and player
        bool resultEven = (uint256(
            keccak256(
                abi.encodePacked(
                    blockhash(block.number - 1),
                    block.timestamp,
                    msg.sender
                )
            )
        ) & 1) == 0;

        bool win = (guessEven == resultEven);
        if (win) {
            require(vin.transfer(msg.sender, payout), "PAYOUT_FAILED");
        }

        emit Played(msg.sender, amount, guessEven, resultEven, win);
    }
}
