import { Wallet, getCreateAddress, ZeroAddress } from 'ethers';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { AlgebraFactory, AlgebraPoolDeployer, AlgebraCommunityVault, TestERC20 } from '../typechain';
import { expect } from './shared/expect';

describe('AlgebraCommunityVault', () => {
  let wallet: Wallet, other: Wallet, third: Wallet;

  let factory: AlgebraFactory;
  let poolDeployer: AlgebraPoolDeployer;
  let vault: AlgebraCommunityVault;

  let token0: TestERC20;
  let token1: TestERC20;

  const AMOUNT = 10n ** 18n;

  const fixture = async () => {
    const [deployer] = await ethers.getSigners();
    // precompute
    const poolDeployerAddress = getCreateAddress({
      from: deployer.address,
      nonce: (await ethers.provider.getTransactionCount(deployer.address)) + 1,
    });

    const factoryFactory = await ethers.getContractFactory('AlgebraFactory');
    const _factory = (await factoryFactory.deploy(poolDeployerAddress)) as any as AlgebraFactory;

    const vaultAddress = await _factory.communityVault();
    const vaultFactory = await ethers.getContractFactory('AlgebraCommunityVault');
    vault = vaultFactory.attach(vaultAddress) as any as AlgebraCommunityVault;

    const tokenFactory = await ethers.getContractFactory('TestERC20');
    token0 = (await tokenFactory.deploy(2n ** 255n)) as any as TestERC20;
    token1 = (await tokenFactory.deploy(2n ** 255n)) as any as TestERC20;

    const poolDeployerFactory = await ethers.getContractFactory('AlgebraPoolDeployer');
    poolDeployer = (await poolDeployerFactory.deploy(_factory, vault)) as any as AlgebraPoolDeployer;
    return _factory;
  };

  before('create fixture loader', async () => {
    [wallet, other, third] = await (ethers as any).getSigners();
  });

  beforeEach('add tokens to vault', async () => {
    factory = await loadFixture(fixture);
    await token0.transfer(vault, AMOUNT);
    await token1.transfer(vault, AMOUNT);
  });

  describe('#Withdraw', async () => {
    describe('successful cases', async () => {
      let communityFeeReceiver: string;

      beforeEach('set communityFee receiver', async () => {
        communityFeeReceiver = wallet.address;
        await vault.changeCommunityFeeReceiver(communityFeeReceiver);

        await vault.transferAlgebraFeeManagerRole(other.address);
        await vault.connect(other).acceptAlgebraFeeManagerRole();
      });

      describe('Algebra fee off', async () => {
        it('withdraw works', async () => {
          let balanceBefore = await token0.balanceOf(communityFeeReceiver);
          await vault.withdraw(token0, AMOUNT);
          let balanceAfter = await token0.balanceOf(communityFeeReceiver);
          expect(balanceAfter - balanceBefore).to.eq(AMOUNT);
        });

        it('algebra fee manager can withdraw', async () => {
          let balanceBefore = await token0.balanceOf(communityFeeReceiver);

          const _vault = vault.connect(third);
          await expect(_vault.withdraw(token0, AMOUNT)).to.be.reverted;

          await _vault.connect(other).withdraw(token0, AMOUNT);

          let balanceAfter = await token0.balanceOf(communityFeeReceiver);
          expect(balanceAfter - balanceBefore).to.eq(AMOUNT);
        });

        it('withdrawTokens works', async () => {
          let balance0Before = await token0.balanceOf(communityFeeReceiver);
          let balance1Before = await token1.balanceOf(communityFeeReceiver);
          await vault.withdrawTokens([
            {
              token: token0,
              amount: AMOUNT,
            },
            {
              token: token1,
              amount: AMOUNT,
            },
          ]);
          let balance0After = await token0.balanceOf(communityFeeReceiver);
          let balance1After = await token1.balanceOf(communityFeeReceiver);
          expect(balance0After - balance0Before).to.eq(AMOUNT);
          expect(balance1After - balance1Before).to.eq(AMOUNT);
        });
      });

      describe('Algebra fee on', async () => {
        let algebraFeeReceiver: string;
        const ALGEBRA_FEE = 100n; // 10%

        beforeEach('turn on algebra fee', async () => {
          algebraFeeReceiver = other.address;
          await vault.connect(other).changeAlgebraFeeReceiver(algebraFeeReceiver);

          await vault.connect(other).proposeAlgebraFeeChange(ALGEBRA_FEE);
          await vault.acceptAlgebraFeeChangeProposal(ALGEBRA_FEE);
        });

        it('withdraw works', async () => {
          let balanceBefore = await token0.balanceOf(communityFeeReceiver);
          let balanceAlgebraBefore = await token0.balanceOf(algebraFeeReceiver);

          await vault.withdraw(token0, AMOUNT);
          let balanceAfter = await token0.balanceOf(communityFeeReceiver);
          let balanceAlgebraAfter = await token0.balanceOf(algebraFeeReceiver);

          expect(balanceAfter - balanceBefore).to.eq(AMOUNT - (AMOUNT * ALGEBRA_FEE / 1000n));
          expect(balanceAlgebraAfter - balanceAlgebraBefore).to.eq(AMOUNT * ALGEBRA_FEE / 1000n);
        });

        it('algebra fee manager can withdraw', async () => {
          let balanceBefore = await token0.balanceOf(communityFeeReceiver);
          let balanceAlgebraBefore = await token0.balanceOf(algebraFeeReceiver);

          const _vault = vault.connect(third);

          await expect(_vault.withdraw(token0, AMOUNT)).to.be.reverted;

          await _vault.connect(other).withdraw(token0, AMOUNT)

          let balanceAfter = await token0.balanceOf(communityFeeReceiver);
          let balanceAlgebraAfter = await token0.balanceOf(algebraFeeReceiver);

          expect(balanceAfter - balanceBefore).to.eq(AMOUNT - (AMOUNT * ALGEBRA_FEE / 1000n));
          expect(balanceAlgebraAfter - balanceAlgebraBefore).to.eq(AMOUNT * ALGEBRA_FEE / 1000n);
        });

        it('withdrawTokens works', async () => {
          let balance0Before = await token0.balanceOf(communityFeeReceiver);
          let balance1Before = await token1.balanceOf(communityFeeReceiver);
          let balance0AlgebraBefore = await token0.balanceOf(algebraFeeReceiver);
          let balance1AlgebraBefore = await token1.balanceOf(algebraFeeReceiver);

          await vault.withdrawTokens([
            {
              token: token0,
              amount: AMOUNT,
            },
            {
              token: token1,
              amount: AMOUNT,
            },
          ]);
          let balance0After = await token0.balanceOf(communityFeeReceiver);
          let balance1After = await token1.balanceOf(communityFeeReceiver);
          let balance0AlgebraAfter = await token0.balanceOf(algebraFeeReceiver);
          let balance1AlgebraAfter = await token1.balanceOf(algebraFeeReceiver);

          expect(balance0After - balance0Before).to.eq(AMOUNT - (AMOUNT * ALGEBRA_FEE / 1000n));
          expect(balance1After - balance1Before).to.eq(AMOUNT - (AMOUNT * ALGEBRA_FEE / 1000n));
          expect(balance0AlgebraAfter - balance0AlgebraBefore).to.eq(AMOUNT * ALGEBRA_FEE / 1000n);
          expect(balance1AlgebraAfter - balance1AlgebraBefore).to.eq(AMOUNT * ALGEBRA_FEE / 1000n);
        });
      });
    });

    describe('failing cases', async () => {
      it('withdraw onlyWithdrawer', async () => {
        await vault.changeCommunityFeeReceiver(wallet.address);
        expect(await vault.communityFeeReceiver()).to.be.eq(wallet.address);
        await expect(vault.connect(other).withdraw(token0, AMOUNT)).to.be.reverted;
      });

      it('cannot withdraw without communityFeeReceiver', async () => {
        await expect(vault.withdraw(token0, AMOUNT)).to.be.revertedWith('invalid receiver');
      });

      it('withdrawTokens onlyWithdrawer', async () => {
        await vault.changeCommunityFeeReceiver(wallet.address);
        expect(await vault.communityFeeReceiver()).to.be.eq(wallet.address);
        await expect(
          vault.connect(other).withdrawTokens([
            {
              token: token0,
              amount: AMOUNT,
            },
          ])
        ).to.be.reverted;
      });

      it('cannot withdrawTokens without communityFeeReceiver', async () => {
        await expect(
          vault.withdrawTokens([
            {
              token: token0,
              amount: AMOUNT,
            },
          ])
        ).to.be.revertedWith('invalid receiver');
      });

      describe('Algebra fee on', async () => {
        const ALGEBRA_FEE = 100n; // 10%

        beforeEach('turn on algebra fee', async () => {
          await vault.proposeAlgebraFeeChange(ALGEBRA_FEE);
          await vault.acceptAlgebraFeeChangeProposal(ALGEBRA_FEE);
        });

        it('cannot withdraw without algebraFeeReceiver', async () => {
          await vault.changeCommunityFeeReceiver(wallet.address);
          expect(await vault.communityFeeReceiver()).to.be.eq(wallet.address);
          await expect(vault.withdraw(token0, AMOUNT)).to.be.revertedWith('invalid algebra fee receiver');
        });

        it('cannot withdrawTokens without algebraFeeReceiver', async () => {
          await vault.changeCommunityFeeReceiver(wallet.address);
          expect(await vault.communityFeeReceiver()).to.be.eq(wallet.address);
          await expect(
            vault.withdrawTokens([
              {
                token: token0,
                amount: AMOUNT,
              },
            ])
          ).to.be.revertedWith('invalid algebra fee receiver');
        });
      });
    });
  });

  describe('#FactoryOwner permissioned actions', async () => {
    const ALGEBRA_FEE = 100n; // 10%

    it('can accept fee change proposal', async () => {
      await vault.proposeAlgebraFeeChange(ALGEBRA_FEE);
      await vault.acceptAlgebraFeeChangeProposal(ALGEBRA_FEE);
      expect(await vault.algebraFee()).to.be.eq(ALGEBRA_FEE);
      expect(await vault.hasNewAlgebraFeeProposal()).to.be.eq(false);
    });

    it('only factory owner can accept fee change proposal', async () => {
      await vault.proposeAlgebraFeeChange(ALGEBRA_FEE);
      await expect(vault.connect(other).acceptAlgebraFeeChangeProposal(ALGEBRA_FEE)).to.be.reverted;
      await expect(vault.acceptAlgebraFeeChangeProposal(ALGEBRA_FEE)).to.not.be.reverted;
    });

    it('can not accept invalid fee change proposal', async () => {
      await vault.proposeAlgebraFeeChange(ALGEBRA_FEE);
      await expect(vault.acceptAlgebraFeeChangeProposal(ALGEBRA_FEE - 1n)).to.be.revertedWith('invalid new fee');
    });

    it('can not accept fee if nothing proposed', async () => {
      await expect(vault.acceptAlgebraFeeChangeProposal(ALGEBRA_FEE)).to.be.revertedWith('not proposed');
    });

    it('can change communityFeeReceiver', async () => {
      await vault.changeCommunityFeeReceiver(other.address);
      expect(await vault.communityFeeReceiver()).to.be.eq(other.address);
    });

    it('can not change communityFeeReceiver to zero address', async () => {
      await expect(vault.changeCommunityFeeReceiver(ZeroAddress)).to.be.reverted;
    });

    it('only factory owner can change communityFeeReceiver', async () => {
      await expect(vault.connect(other).changeCommunityFeeReceiver(other.address)).to.be.reverted;
    });
  });

  describe('#AlgebraFeeManager permissioned actions', async () => {
    const ALGEBRA_FEE = 100n; // 10%

    it('can transfer AlgebraFeeManager role', async () => {
      await vault.transferAlgebraFeeManagerRole(other.address);
      await vault.connect(other).acceptAlgebraFeeManagerRole();
      expect(await vault.algebraFeeManager()).to.be.eq(other.address);
    });

    it('only pending newAlgebraFeeManager can accept AlgebraFeeManager role', async () => {
      await vault.transferAlgebraFeeManagerRole(other.address);
      await expect(vault.acceptAlgebraFeeManagerRole()).to.be.reverted;
      await expect(vault.connect(other).acceptAlgebraFeeManagerRole()).to.not.be.reverted;
    });

    it('only AlgebraFeeManager can transfer AlgebraFeeManager role', async () => {
      await expect(vault.connect(other).transferAlgebraFeeManagerRole(other.address)).to.be.reverted;
    });

    it('can change AlgebraFeeReceiver', async () => {
      await expect(vault.connect(other).changeAlgebraFeeReceiver(other.address)).to.be.reverted;
      await expect(vault.changeAlgebraFeeReceiver(ZeroAddress)).to.be.reverted;

      await vault.changeAlgebraFeeReceiver(other.address);
      expect(await vault.algebraFeeReceiver()).to.be.eq(other.address);
    });

    it('can propose new fee and cancel proposal', async () => {
      expect(await vault.proposedNewAlgebraFee()).to.be.eq(0);
      expect(await vault.hasNewAlgebraFeeProposal()).to.be.eq(false);

      await expect(vault.connect(other).proposeAlgebraFeeChange(ALGEBRA_FEE)).to.be.reverted;
      await expect(vault.proposeAlgebraFeeChange(1001)).to.be.reverted;

      await vault.proposeAlgebraFeeChange(ALGEBRA_FEE);
      expect(await vault.proposedNewAlgebraFee()).to.be.eq(ALGEBRA_FEE);
      expect(await vault.hasNewAlgebraFeeProposal()).to.be.eq(true);

      await expect(vault.connect(other).cancelAlgebraFeeChangeProposal()).to.be.reverted;
      await vault.cancelAlgebraFeeChangeProposal();

      expect(await vault.proposedNewAlgebraFee()).to.be.eq(0);
      expect(await vault.hasNewAlgebraFeeProposal()).to.be.eq(false);
    });
  });
});
