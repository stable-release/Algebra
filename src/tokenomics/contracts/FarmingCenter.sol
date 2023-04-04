// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.17;

import './interfaces/IFarmingCenter.sol';
import './interfaces/IFarmingCenterVault.sol';

import '@cryptoalgebra/core/contracts/interfaces/IAlgebraPool.sol';
import '@cryptoalgebra/core/contracts/interfaces/IERC20Minimal.sol';
import '@cryptoalgebra/periphery/contracts/interfaces/IPositionFollower.sol';
import '@cryptoalgebra/periphery/contracts/interfaces/INonfungiblePositionManager.sol';
import '@cryptoalgebra/periphery/contracts/base/Multicall.sol';
import '@cryptoalgebra/periphery/contracts/libraries/TransferHelper.sol';

import './libraries/IncentiveId.sol';

/// @title Algebra main farming contract
/// @dev Manages farmings and performs entry, exit and other actions.
contract FarmingCenter is IFarmingCenter, IPositionFollower, Multicall {
    IAlgebraEternalFarming public immutable override eternalFarming;
    INonfungiblePositionManager public immutable override nonfungiblePositionManager;
    IFarmingCenterVault public immutable override farmingCenterVault;

    /// @dev saves addresses of virtual pools for pool
    mapping(address => VirtualPoolAddresses) private _virtualPoolAddresses;

    /// @dev deposits[tokenId] => Deposit
    mapping(uint256 => Deposit) public override deposits;

    mapping(bytes32 => IncentiveKey) public incentiveKeys;

    /// @notice Represents the deposit of a liquidity NFT
    struct Deposit {
        bytes32 eternalIncentiveId;
    }

    constructor(
        IAlgebraEternalFarming _eternalFarming,
        INonfungiblePositionManager _nonfungiblePositionManager,
        IFarmingCenterVault _farmingCenterVault
    ) {
        eternalFarming = _eternalFarming;
        nonfungiblePositionManager = _nonfungiblePositionManager;
        farmingCenterVault = _farmingCenterVault;
    }

    modifier isOwner(uint256 tokenId) {
        require(nonfungiblePositionManager.ownerOf(tokenId) == msg.sender, 'not owner');
        _;
    }

    function _getTokenBalanceOfVault(address token) private view returns (uint256 balance) {
        return IERC20Minimal(token).balanceOf(address(farmingCenterVault));
    }

    /// @inheritdoc IFarmingCenter
    function enterFarming(
        IncentiveKey memory key,
        uint256 tokenId,
        uint256 tokensLocked
    ) external override isOwner(tokenId) {
        Deposit storage _deposit = deposits[tokenId];
        bytes32 incentiveId = IncentiveId.compute(key);
        if (address(incentiveKeys[incentiveId].pool) == address(0)) {
            incentiveKeys[incentiveId] = key;
        }

        IAlgebraFarming _farming = IAlgebraFarming(eternalFarming);
        require(_deposit.eternalIncentiveId == bytes32(0), 'token already farmed');
        _deposit.eternalIncentiveId = incentiveId;
        nonfungiblePositionManager.switchFarmingStatus(tokenId, true);

        (, , , , , address multiplierToken, , ) = _farming.incentives(incentiveId);
        if (tokensLocked > 0) {
            uint256 balanceBefore = _getTokenBalanceOfVault(multiplierToken);
            TransferHelper.safeTransferFrom(multiplierToken, msg.sender, address(farmingCenterVault), tokensLocked);
            uint256 balanceAfter = _getTokenBalanceOfVault(multiplierToken);
            require(balanceAfter > balanceBefore, 'Insufficient tokens locked');
            unchecked {
                tokensLocked = balanceAfter - balanceBefore;
            }
            farmingCenterVault.lockTokens(tokenId, incentiveId, tokensLocked);
        }

        _farming.enterFarming(key, tokenId, tokensLocked);
    }

    /// @inheritdoc IFarmingCenter
    function exitFarming(IncentiveKey memory key, uint256 tokenId) external override isOwner(tokenId) {
        _exitFarming(key, tokenId, msg.sender);
    }

    function _exitFarming(IncentiveKey memory key, uint256 tokenId, address tokenOwner) private {
        Deposit storage deposit = deposits[tokenId];

        bytes32 incentiveId = IncentiveId.compute(key);
        require(deposit.eternalIncentiveId == incentiveId, 'invalid incentiveId');
        deposit.eternalIncentiveId = bytes32(0);
        nonfungiblePositionManager.switchFarmingStatus(tokenId, false);

        IAlgebraFarming _farming = IAlgebraFarming(eternalFarming);
        _farming.exitFarming(key, tokenId, tokenOwner);

        (, , , , , address multiplierToken, , ) = _farming.incentives(incentiveId);
        if (multiplierToken != address(0)) {
            farmingCenterVault.claimTokens(multiplierToken, tokenOwner, tokenId, incentiveId);
        }
    }

    /// @inheritdoc IPositionFollower
    function increaseLiquidity(uint256 tokenId, uint256 liquidityDelta) external override {
        require(msg.sender == address(nonfungiblePositionManager), 'only nonfungiblePosManager');
        Deposit storage deposit = deposits[tokenId];

        bytes32 _eternalIncentiveId = deposit.eternalIncentiveId;
        if (_eternalIncentiveId != bytes32(0)) {
            address tokenOwner = nonfungiblePositionManager.ownerOf(tokenId);
            (, , , , , , uint128 liquidity, , , , ) = nonfungiblePositionManager.positions(tokenId);

            _reenterToFarming(_eternalIncentiveId, tokenId, tokenOwner, liquidity);
        }
    }

    /// @inheritdoc IPositionFollower
    function decreaseLiquidity(uint256 tokenId, uint256 liquidityDelta) external override returns (bool success) {
        require(msg.sender == address(nonfungiblePositionManager), 'only nonfungiblePosManager');
        Deposit storage deposit = deposits[tokenId];

        bytes32 _eternalIncentiveId = deposit.eternalIncentiveId;
        if (_eternalIncentiveId != bytes32(0)) {
            address tokenOwner = nonfungiblePositionManager.ownerOf(tokenId);
            (, , , , , , uint128 liquidity, , , , ) = nonfungiblePositionManager.positions(tokenId);

            _reenterToFarming(_eternalIncentiveId, tokenId, tokenOwner, liquidity);
        }
        return true;
    }

    function _reenterToFarming(bytes32 incentiveId, uint256 tokenId, address tokenOwner, uint128 liquidity) private {
        IAlgebraFarming _farming = IAlgebraFarming(eternalFarming);
        IncentiveKey memory key = incentiveKeys[incentiveId];

        if (liquidity == 0) {
            _exitFarming(key, tokenId, tokenOwner);
        } else {
            _farming.exitFarming(key, tokenId, tokenOwner);
            _farming.enterFarming(key, tokenId, farmingCenterVault.balances(tokenId, incentiveId));
        }
    }

    /// @inheritdoc IPositionFollower
    function burnPosition(uint256 tokenId) external override returns (bool success) {
        require(msg.sender == address(nonfungiblePositionManager), 'only nonfungiblePosManager');
        Deposit storage deposit = deposits[tokenId];

        if (deposit.eternalIncentiveId != bytes32(0)) {
            IncentiveKey memory key = incentiveKeys[deposit.eternalIncentiveId];
            _exitFarming(key, tokenId, nonfungiblePositionManager.ownerOf(tokenId));
        }
        return true;
    }

    /// @inheritdoc IFarmingCenter
    function collectRewards(
        IncentiveKey memory key,
        uint256 tokenId
    ) external override isOwner(tokenId) returns (uint256 reward, uint256 bonusReward) {
        (reward, bonusReward) = eternalFarming.collectRewards(key, tokenId, msg.sender);
    }

    function _claimRewardFromFarming(
        IAlgebraFarming _farming,
        IERC20Minimal rewardToken,
        address to,
        uint256 amountRequested
    ) internal returns (uint256 reward) {
        return _farming.claimRewardFrom(rewardToken, msg.sender, to, amountRequested);
    }

    /// @inheritdoc IFarmingCenter
    function claimReward(
        IERC20Minimal rewardToken,
        address to,
        uint256 amountRequested
    ) external override returns (uint256 reward) {
        unchecked {
            if (amountRequested != 0) {
                reward += eternalFarming.claimRewardFrom(rewardToken, msg.sender, to, amountRequested);
            }
        }
    }

    /// @inheritdoc IFarmingCenter
    function connectVirtualPool(IAlgebraPool pool, address newVirtualPool) external override {
        require(msg.sender == address(eternalFarming), 'only farming can call this');

        VirtualPoolAddresses storage virtualPools = _virtualPoolAddresses[address(pool)];
        pool.setIncentive(newVirtualPool);

        virtualPools.eternalVirtualPool = newVirtualPool;
    }

    function virtualPoolAddresses(address pool) external view override returns (address eternalVP) {
        (eternalVP) = (_virtualPoolAddresses[pool].eternalVirtualPool);
    }
}
