// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceFeed} from "./Mandate.sol";

/**
 * @title PinnedFeed
 * @notice A Chainlink-shaped price feed for networks where Chainlink does not publish.
 *
 * Arc mainnet has live Chainlink feeds; Arc testnet has none. A Mandate refuses
 * to trade without a fresh price, so testing one on testnet needs a feed that
 * exists. This contract carries an answer copied from the real mainnet feed and
 * pushed by a single publisher.
 *
 * It is deliberately not a substitute for an oracle: there is no aggregation, no
 * deviation threshold and no independence. It is for testnets only. A mandate on
 * mainnet is given the real Chainlink aggregator instead, and nothing here is
 * deployed there.
 */
contract PinnedFeed is IPriceFeed {
    uint8 public immutable override decimals;
    string public description;

    address public publisher;

    int256 private _answer;
    uint256 private _updatedAt;
    uint80 private _round;

    event Published(uint80 indexed round, int256 answer, uint256 updatedAt);
    event PublisherChanged(address indexed from, address indexed to);

    error NotPublisher();
    error BadAnswer();
    error BadPublisher();

    constructor(uint8 decimals_, string memory description_, int256 answer_) {
        if (answer_ <= 0) revert BadAnswer();
        decimals = decimals_;
        description = description_;
        publisher = msg.sender;
        _answer = answer_;
        _updatedAt = block.timestamp;
        _round = 1;
        emit Published(1, answer_, block.timestamp);
    }

    /// Copy a fresh answer across from the mainnet feed.
    function publish(int256 answer_) external {
        if (msg.sender != publisher) revert NotPublisher();
        if (answer_ <= 0) revert BadAnswer();
        _answer = answer_;
        _updatedAt = block.timestamp;
        _round += 1;
        emit Published(_round, answer_, block.timestamp);
    }

    /// Hand the role on. Never to nobody: a feed no one can update goes stale
    /// forever, and every mandate reading it would stop trading for good.
    function setPublisher(address to) external {
        if (msg.sender != publisher) revert NotPublisher();
        if (to == address(0)) revert BadPublisher();
        emit PublisherChanged(publisher, to);
        publisher = to;
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (_round, _answer, _updatedAt, _updatedAt, _round);
    }
}
