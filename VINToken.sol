/* SPDX-License-Identifier: MIT */
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract VINToken is ERC20 {
    constructor() ERC20("VIN", "VIN") {
        _mint(msg.sender, 100_000_000 * 10 ** decimals());
    }
}

