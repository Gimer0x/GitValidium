/* eslint-disable no-plusplus, no-await-in-loop */
const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

const { contractUtils } = require('@0xpolygonhermez/zkevm-commonjs');

const { calculateSnarkInput, calculateAccInputHash, calculateBatchHashData } = contractUtils;

describe('CDKValidium Rollback', () => {
    let deployer;
    let trustedAggregator;
    let trustedSequencer;
    let admin;
    let aggregator1;

    let verifierContract;
    let PolygonZkEVMBridgeContract;
    let cdkValidiumContract;
    let cdkDataCommitteeContract;
    let maticTokenContract;
    let PolygonZkEVMGlobalExitRoot;
    let l2CoinBase;
    const ZERO_VALUE = 0;
    const maticTokenName = 'Matic Token';
    const maticTokenSymbol = 'MATIC';
    const maticTokenInitialBalance = ethers.utils.parseEther('20000000');
    const zkProofFFlonk = new Array(24).fill(ethers.constants.HashZero);

    const genesisRoot = '0x0000000000000000000000000000000000000000000000000000000000000001';

    const networkIDMainnet = 0;
    const urlSequencer = 'http://cdk-validium-json-rpc:8123';
    const chainID = 1000;
    const networkName = 'cdk-validium';
    const version = '0.0.1';
    const forkID = 0;
    const pendingStateTimeoutDefault = 100;
    const trustedAggregatorTimeoutDefault = 10;
    let firstDeployment = true;

    // CDKValidium Constants
    const FORCE_BATCH_TIMEOUT = 60 * 60 * 24 * 5; // 5 days
    const MAX_BATCH_MULTIPLIER = 12;
    const HALT_AGGREGATION_TIMEOUT = 60 * 60 * 24 * 7; // 7 days
    const FORCED_TX_WINDOW = 60 * 60 * 24 * 7; // 7 days
    const FINALITY_PERIOD = 60 * 60 * 24 * 7; // 7 days
    const REVERT_PERIOD = 60 * 60;
    const _MAX_VERIFY_BATCHES = 1000;    
    beforeEach('Deploy contract', async () => {
        upgrades.silenceWarnings();

        // load signers
        [deployer, trustedAggregator, trustedSequencer, admin, aggregator1, user] = await ethers.getSigners();

        // deploy mock verifier
        const VerifierRollupHelperFactory = await ethers.getContractFactory(
            'VerifierRollupHelperMock',
        );
        verifierContract = await VerifierRollupHelperFactory.deploy();

        // deploy MATIC
        const maticTokenFactory = await ethers.getContractFactory('ERC20PermitMock');
        maticTokenContract = await maticTokenFactory.deploy(
            maticTokenName,
            maticTokenSymbol,
            deployer.address,
            maticTokenInitialBalance,
        );
        await maticTokenContract.deployed();

        /*
         * deploy global exit root manager
         * In order to not have trouble with nonce deploy first proxy admin
         */
        await upgrades.deployProxyAdmin();
        if ((await upgrades.admin.getInstance()).address !== '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0') {
            firstDeployment = false;
        }
        const nonceProxyBridge = Number((await ethers.provider.getTransactionCount(deployer.address))) + (firstDeployment ? 3 : 2);
        const nonceProxyCommittee = nonceProxyBridge + (firstDeployment ? 2 : 1);

        // Always have to redeploy impl since the PolygonZkEVMGlobalExitRoot address changes
        const nonceProxyCDKValidium = nonceProxyCommittee + 2;

        const precalculateBridgeAddress = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxyBridge });
        const precalculateCommitteeAddress = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxyCommittee });
        const precalculateCDKValidiumAddress = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxyCDKValidium });
        firstDeployment = false;

        const PolygonZkEVMGlobalExitRootFactory = await ethers.getContractFactory('PolygonZkEVMGlobalExitRoot');
        PolygonZkEVMGlobalExitRoot = await upgrades.deployProxy(PolygonZkEVMGlobalExitRootFactory, [], {
            initializer: false,
            constructorArgs: [precalculateCDKValidiumAddress, precalculateBridgeAddress],
            unsafeAllow: ['constructor', 'state-variable-immutable'],
        });

        // deploy PolygonZkEVMBridge
        const PolygonZkEVMBridgeFactory = await ethers.getContractFactory('PolygonZkEVMBridge');
        PolygonZkEVMBridgeContract = await upgrades.deployProxy(PolygonZkEVMBridgeFactory, [], { initializer: false });

        // deploy CDKDataCommittee
        const cdkDataCommitteeFactory = await ethers.getContractFactory('CDKDataCommittee');
        cdkDataCommitteeContract = await upgrades.deployProxy(
            cdkDataCommitteeFactory,
            [],
            { initializer: false },
        );

        // deploy CDKValidiumMock
        const CDKValidiumFactory = await ethers.getContractFactory('CDKValidiumMock');
        cdkValidiumContract = await upgrades.deployProxy(CDKValidiumFactory, [], {
            initializer: false,
            constructorArgs: [
                PolygonZkEVMGlobalExitRoot.address,
                maticTokenContract.address,
                verifierContract.address,
                PolygonZkEVMBridgeContract.address,
                cdkDataCommitteeContract.address,
                chainID,
                forkID,
            ],
            unsafeAllow: ['constructor', 'state-variable-immutable'],
        });

        expect(precalculateBridgeAddress).to.be.equal(PolygonZkEVMBridgeContract.address);
        expect(precalculateCommitteeAddress).to.be.equal(cdkDataCommitteeContract.address);
        expect(precalculateCDKValidiumAddress).to.be.equal(cdkValidiumContract.address);

        await PolygonZkEVMBridgeContract.initialize(networkIDMainnet, PolygonZkEVMGlobalExitRoot.address, cdkValidiumContract.address);
        await cdkValidiumContract.initialize(
            {
                admin: admin.address,
                trustedSequencer: trustedSequencer.address,
                pendingStateTimeout: pendingStateTimeoutDefault,
                trustedAggregator: trustedAggregator.address,
                trustedAggregatorTimeout: trustedAggregatorTimeoutDefault,
            },
            genesisRoot,
            urlSequencer,
            networkName,
            version,
        );
        await cdkDataCommitteeContract.initialize();
        const expectedHash = ethers.utils.solidityKeccak256(['bytes'], [[]]);
        await expect(cdkDataCommitteeContract.connect(deployer)
            .setupCommittee(0, [], []))
            .to.emit(cdkDataCommitteeContract, 'CommitteeUpdated')
            .withArgs(expectedHash);

        // Fund sequencer address with Matic tokens
        const maticAmount = ethers.utils.parseEther('1000');
        await maticTokenContract.transfer(trustedSequencer.address, maticAmount);
        await maticTokenContract.transfer(user.address, maticAmount);

        await expect(
            maticTokenContract.connect(trustedSequencer).approve(cdkValidiumContract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        await expect(
            maticTokenContract.connect(user).approve(cdkValidiumContract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        l2CoinBase = trustedSequencer.address;
    });
    
    describe("Revert mode testing", () => {
        it("should activate revert mode after calling sequenceBatches()", async () => {
            const l2txDataForceBatch = '0x123456';
            const maticAmount = await cdkValidiumContract.getForcedBatchFee();
            const lastGlobalExitRoot = await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot();

            let lastRevertModeTimestamp =  await cdkValidiumContract.lastRevertModeTimestamp();
            expect(lastRevertModeTimestamp.toNumber() + REVERT_PERIOD)
                .to.be.lessThan((await ethers.provider.getBlock()).timestamp);

            await expect(
                cdkValidiumContract.connect(admin).activateForceBatches(),
            ).to.emit(cdkValidiumContract, 'ActivateForceBatches');

            // lastForceBatch should be equal to zero
            const lastForcedBatch = (await cdkValidiumContract.lastForceBatch()).toNumber();
            await expect(cdkValidiumContract.connect(user).forceBatch(l2txDataForceBatch, maticAmount))
                .to.emit(cdkValidiumContract, 'ForceBatch')
                .withArgs(lastForcedBatch + 1, lastGlobalExitRoot, user.address, '0x');
            
            const l2txData = '0x123456';
            const transactionsHash = calculateBatchHashData(l2txData);
            const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

            const batchData = {
                transactionsHash,
                globalExitRoot: ethers.constants.HashZero,
                timestamp: ethers.BigNumber.from(currentTimestamp),
                minForcedTimestamp: 0
            }

            await ethers.provider.send('evm_setNextBlockTimestamp', [currentTimestamp + FORCED_TX_WINDOW]);

            // Sequence a batch
            await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches([batchData],l2CoinBase,[]))
                .to.emit(cdkValidiumContract, "SequenceBatches")
                .withArgs(1);

            const forceBatchStruct1 = {
                transactions: l2txDataForceBatch,
                globalExitRoot: lastGlobalExitRoot,
                minForcedTimestamp: currentTimestamp
            };

            await expect(cdkValidiumContract.connect(user).enterRevertMode(forceBatchStruct1))
                .to.emit(cdkValidiumContract, 'ActivateRevertMode')
                .withArgs(user.address, 1);

            lastRevertModeTimestamp =  await cdkValidiumContract.lastRevertModeTimestamp();
            expect(lastRevertModeTimestamp.toNumber() + REVERT_PERIOD)
                .to.be.greaterThanOrEqual((await ethers.provider.getBlock()).timestamp);
            
        });

    
        it("should activate revert mode after not sequencing a batch using sequenceBatches()", async () => {
            const l2txDataForceBatch1 = '0x123456';
            const transactionsHashForceBatch = calculateBatchHashData(l2txDataForceBatch1);

            const l2txDataForceBatch2 = '0x789101';
            const maticAmount = await cdkValidiumContract.getForcedBatchFee();
            const lastGlobalExitRoot = await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot();

            let lastRevertModeTimestamp =  await cdkValidiumContract.lastRevertModeTimestamp();
            expect(lastRevertModeTimestamp.toNumber() + REVERT_PERIOD)
                .to.be.lessThan((await ethers.provider.getBlock()).timestamp);

            await expect(
                cdkValidiumContract.connect(admin).activateForceBatches(),
            ).to.emit(cdkValidiumContract, 'ActivateForceBatches');

            // lastForceBatch should be equal to zero
            const lastForcedBatch1 = (await cdkValidiumContract.lastForceBatch()).toNumber();
            await expect(cdkValidiumContract.connect(user).forceBatch(l2txDataForceBatch1, maticAmount))
                .to.emit(cdkValidiumContract, 'ForceBatch')
                .withArgs(lastForcedBatch1 + 1, lastGlobalExitRoot, user.address, '0x');

            const timestampForceBatch1 = (await ethers.provider.getBlock()).timestamp;

            const forceBatchStruct1 = {
                transactions: l2txDataForceBatch1,
                globalExitRoot: lastGlobalExitRoot,
                minForcedTimestamp: timestampForceBatch1,
            };

            const lastForcedBatch2 = (await cdkValidiumContract.lastForceBatch()).toNumber();
            await expect(cdkValidiumContract.connect(user).forceBatch(l2txDataForceBatch2, maticAmount))
                .to.emit(cdkValidiumContract, 'ForceBatch')
                .withArgs(lastForcedBatch2 + 1, lastGlobalExitRoot, user.address, '0x');

            const timestampForceBatch2 = (await ethers.provider.getBlock()).timestamp;

            const forceBatchStruct2 = {
                transactions: l2txDataForceBatch2,
                globalExitRoot: lastGlobalExitRoot,
                minForcedTimestamp: timestampForceBatch2,
            };

            expect(await cdkValidiumContract.lastForceBatchSequenced()).to.be.equal(0);
            expect(await cdkValidiumContract.lastBatchSequenced()).to.be.equal(0);
            expect(await cdkValidiumContract.lastForceBatch()).to.be.equal(2);

            // Increment timestamp + ForceBatchTimeOut (5 days)
            await ethers.provider.send('evm_setNextBlockTimestamp', [timestampForceBatch1 + FORCE_BATCH_TIMEOUT]);

            const l2txData = '0x123456';
            const transactionsHash = calculateBatchHashData(l2txData);
            const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

            const batchData1 = {
                transactionsHash,
                globalExitRoot: ethers.constants.HashZero,
                timestamp: ethers.BigNumber.from(currentTimestamp),
                minForcedTimestamp: 0
            }
            
            const batchData2 = {
                transactionsHash: transactionsHashForceBatch,
                globalExitRoot: lastGlobalExitRoot,
                timestamp: currentTimestamp,
                minForcedTimestamp: timestampForceBatch1
            }

            // Sequence a batch
            await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches(
                        [batchData1, batchData2],l2CoinBase,[]
                ))
                .to.emit(cdkValidiumContract, "SequenceBatches")
                .withArgs(2);

            expect(await cdkValidiumContract.lastForceBatchSequenced()).to.be.equal(1);
            expect(await cdkValidiumContract.lastBatchSequenced()).to.be.equal(2);
            expect(await cdkValidiumContract.lastForceBatch()).to.be.equal(2);

            await ethers.provider.send('evm_setNextBlockTimestamp', [timestampForceBatch2 + FORCED_TX_WINDOW + 1]);

            // Validate event ActivateRevertMode
            await expect(cdkValidiumContract.connect(user).enterRevertMode(forceBatchStruct2))
                .to.emit(cdkValidiumContract, 'ActivateRevertMode')
                .withArgs(user.address, 2);

            lastRevertModeTimestamp =  await cdkValidiumContract.lastRevertModeTimestamp();
            expect(lastRevertModeTimestamp.toNumber() + REVERT_PERIOD)
                .to.be.greaterThanOrEqual((await ethers.provider.getBlock()).timestamp);
        });

        it("should activate revert mode after not sequencing a batch using sequenceForceBatches()", async () => {
            const l2txDataForceBatch1 = '0x123456';
            const l2txDataForceBatch2 = '0x789101';
            const maticAmount = await cdkValidiumContract.getForcedBatchFee();
            const lastGlobalExitRoot = await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot();

            let lastRevertModeTimestamp =  await cdkValidiumContract.lastRevertModeTimestamp();
            expect(lastRevertModeTimestamp.toNumber() + REVERT_PERIOD)
                .to.be.lessThan((await ethers.provider.getBlock()).timestamp);

            await expect(
                cdkValidiumContract.connect(admin).activateForceBatches(),
            ).to.emit(cdkValidiumContract, 'ActivateForceBatches');

            // lastForceBatch should be equal to zero
            const lastForcedBatch1 = (await cdkValidiumContract.lastForceBatch()).toNumber();
            await expect(cdkValidiumContract.connect(user).forceBatch(l2txDataForceBatch1, maticAmount))
                .to.emit(cdkValidiumContract, 'ForceBatch')
                .withArgs(lastForcedBatch1 + 1, lastGlobalExitRoot, user.address, '0x');

            const timestampForceBatch = (await ethers.provider.getBlock()).timestamp;

            const forceBatchStruct1 = {
                transactions: l2txDataForceBatch1,
                globalExitRoot: lastGlobalExitRoot,
                minForcedTimestamp: timestampForceBatch,
            };

            const forceBatchStruct2 = {
                transactions: l2txDataForceBatch2,
                globalExitRoot: lastGlobalExitRoot,
                minForcedTimestamp: timestampForceBatch + 1,
            };

            const lastForcedBatch2 = (await cdkValidiumContract.lastForceBatch()).toNumber();
            await expect(cdkValidiumContract.connect(user).forceBatch(l2txDataForceBatch2, maticAmount))
                .to.emit(cdkValidiumContract, 'ForceBatch')
                .withArgs(lastForcedBatch2 + 1, lastGlobalExitRoot, user.address, '0x');

            expect(await cdkValidiumContract.lastForceBatchSequenced()).to.be.equal(0);
            expect(await cdkValidiumContract.lastBatchSequenced()).to.be.equal(0);
            expect(await cdkValidiumContract.lastForceBatch()).to.be.equal(2);

            // Increment timestamp + ForceBatchTimeOut (5 days)
            await ethers.provider.send('evm_setNextBlockTimestamp', [timestampForceBatch + FORCE_BATCH_TIMEOUT]);

            await expect(cdkValidiumContract.connect(user).sequenceForceBatches([forceBatchStruct1]))
                .to.emit(cdkValidiumContract, 'SequenceForceBatches')
                .withArgs(1);

            expect(await cdkValidiumContract.lastForceBatchSequenced()).to.be.equal(1);
            expect(await cdkValidiumContract.lastBatchSequenced()).to.be.equal(1);
            expect(await cdkValidiumContract.lastForceBatch()).to.be.equal(2);

            await ethers.provider.send('evm_setNextBlockTimestamp', [timestampForceBatch + FORCED_TX_WINDOW + 1]);

            // Validate event ActivateRevertMode
            await expect(cdkValidiumContract.connect(user).enterRevertMode(forceBatchStruct2))
                .to.emit(cdkValidiumContract, 'ActivateRevertMode')
                .withArgs(user.address, 2);

            lastRevertModeTimestamp =  await cdkValidiumContract.lastRevertModeTimestamp();
            expect(lastRevertModeTimestamp.toNumber() + REVERT_PERIOD)
                .to.be.greaterThanOrEqual((await ethers.provider.getBlock()).timestamp);
        });

        it("should not activat revert mode if forced batches is not active", async () => {
            const l2txDataForceBatch1 = '0x123456';
            const lastGlobalExitRoot = await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot();

            const timestampForceBatch = (await ethers.provider.getBlock()).timestamp;

            const forceBatchStruct = {
                transactions: l2txDataForceBatch1,
                globalExitRoot: lastGlobalExitRoot,
                minForcedTimestamp: timestampForceBatch,
            };

            await expect(cdkValidiumContract.connect(user).enterRevertMode(forceBatchStruct))
                .to.be.revertedWith("ForceBatchNotAllowed")

            let lastRevertModeTimestamp =  await cdkValidiumContract.lastRevertModeTimestamp();
            expect(lastRevertModeTimestamp.toNumber() + REVERT_PERIOD)
                .to.be.lessThan((await ethers.provider.getBlock()).timestamp);
        });

        it("should not activate revert mode if emergency state is activated", async () => {
            const l2txData = '0x123456';
            const transactionsHash = calculateBatchHashData(l2txData);
            const currentTimestamp = (await ethers.provider.getBlock()).timestamp;
            const lastGlobalExitRoot = await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot();

            const batchData = {
                transactionsHash,
                globalExitRoot: ethers.constants.HashZero,
                timestamp: ethers.BigNumber.from(currentTimestamp),
                minForcedTimestamp: 0,
            };

            // Sequence batch
            const lastBatchSequenced = 1;
            await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches(
                    [batchData], trustedSequencer.address, []
                ))
                .to.emit(cdkValidiumContract, 'SequenceBatches')
                .withArgs(lastBatchSequenced);

            const sequencedTimestmap = Number((await cdkValidiumContract.sequencedBatches(1)).sequencedTimestamp);
            const haltTimeout = HALT_AGGREGATION_TIMEOUT;

            await ethers.provider.send('evm_setNextBlockTimestamp', [sequencedTimestmap + haltTimeout]);

            // Succesfully acitvate emergency state
            await expect(cdkValidiumContract.connect(aggregator1).activateEmergencyState(1))
                .to.emit(cdkValidiumContract, 'EmergencyStateActivated');

            const timestampForceBatch = (await ethers.provider.getBlock()).timestamp;

            const forceBatchStruct = {
                transactions: l2txData,
                globalExitRoot: lastGlobalExitRoot,
                minForcedTimestamp: timestampForceBatch,
            };

            await expect(
                cdkValidiumContract.connect(admin).activateForceBatches(),
            ).to.emit(cdkValidiumContract, 'ActivateForceBatches');

            await expect(cdkValidiumContract.connect(user).enterRevertMode(forceBatchStruct))
                .to.be.revertedWith("OnlyNotEmergencyState");
        });
    });

    describe("Rollback testing", () => {
        let l2txDataForceBatch;
        let maticAmount;
        let lastGlobalExitRoot;
        let currentTimestamp;
        let forceBatchStruct1;
        let newLocalExitRoot;
        let newStateRoot;

        beforeEach('Build revert mode scenario', async () => {
            l2txDataForceBatch = '0x123456';
            maticAmount = await cdkValidiumContract.getForcedBatchFee();
            lastGlobalExitRoot = await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot();

            newLocalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000001';
            newStateRoot = '0x0000000000000000000000000000000000000000000000000000000000000002';

            // Activate force batches by admin role
            await expect(
                cdkValidiumContract.connect(admin).activateForceBatches(),
            ).to.emit(cdkValidiumContract, 'ActivateForceBatches');

            const lastForcedBatch = (await cdkValidiumContract.lastForceBatch()).toNumber();

            // lastForcedBatch should be equal to zero. 
            await expect(cdkValidiumContract.connect(user).forceBatch(l2txDataForceBatch, maticAmount))
                .to.emit(cdkValidiumContract, 'ForceBatch')
                .withArgs(lastForcedBatch + 1, lastGlobalExitRoot, user.address, '0x');

            expect((await cdkValidiumContract.lastForceBatch()).toNumber()).to.be.equal(1);

            const l2txData = '0x123456';
            const transactionsHash = calculateBatchHashData(l2txData);
            currentTimestamp = (await ethers.provider.getBlock()).timestamp;

            const batchData = {
                transactionsHash,
                globalExitRoot: ethers.constants.HashZero,
                timestamp: ethers.BigNumber.from(currentTimestamp),
                minForcedTimestamp: 0
            }

            // Sequence a batch
            await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches([batchData],l2CoinBase,[]))
                .to.emit(cdkValidiumContract, "SequenceBatches")
                .withArgs(1);

            forceBatchStruct1 = {
                transactions: l2txDataForceBatch,
                globalExitRoot: lastGlobalExitRoot,
                minForcedTimestamp: currentTimestamp
            };

            await ethers.provider.send('evm_setNextBlockTimestamp', [currentTimestamp + FORCED_TX_WINDOW]);

        });

        it("should revert the last verified batch by a trusted aggregator", async () => {
            await expect(cdkValidiumContract.connect(user).enterRevertMode(forceBatchStruct1))
                .to.emit(cdkValidiumContract, 'ActivateRevertMode')
                .withArgs(user.address, 1);

            const pendingState = 0;
            const numBatch = (await cdkValidiumContract.lastVerifiedBatch()) + 1;

            await expect(
                cdkValidiumContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                    pendingState,
                    numBatch - 1,
                    numBatch,
                    newLocalExitRoot,
                    newStateRoot,
                    zkProofFFlonk,
                ),
            ).to.emit(cdkValidiumContract, 'VerifyBatchesTrustedAggregator')
                .withArgs(numBatch, newStateRoot, trustedAggregator.address);

            expect(await cdkValidiumContract.lastVerifiedBatch()).to.be.equal(1);

            await expect(cdkValidiumContract.revertLastVerifiedBatch()).not.to.be.reverted;

            expect(await cdkValidiumContract.lastVerifiedBatch()).to.be.equal(ZERO_VALUE);
            
        });

        it("should revert the last verified batch by a user", async () => {
            const pendingState = 0;
            const numBatch = (await cdkValidiumContract.lastVerifiedBatch()) + 1;

            await expect(
                cdkValidiumContract.connect(user).verifyBatches(
                    pendingState,
                    numBatch - 1,
                    numBatch,
                    newLocalExitRoot,
                    newStateRoot,
                    zkProofFFlonk,
                ),
            ).to.emit(cdkValidiumContract, 'VerifyBatches')
                .withArgs(numBatch, newStateRoot, user.address);

            currentTimestamp = (await ethers.provider.getBlock()).timestamp;

            await ethers.provider.send('evm_setNextBlockTimestamp', [currentTimestamp + pendingStateTimeoutDefault]);

            await cdkValidiumContract.consolidatePendingState(1);

            await expect(cdkValidiumContract.revertLastVerifiedBatch())
                .to.be.revertedWith("RevertModeIsNotActive");

            await expect(cdkValidiumContract.connect(user).enterRevertMode(forceBatchStruct1))
                .to.emit(cdkValidiumContract, 'ActivateRevertMode')
                .withArgs(user.address, 1);

            expect(await cdkValidiumContract.lastVerifiedBatch()).to.be.equal(1);

            await expect(cdkValidiumContract.revertLastVerifiedBatch())
                .to.emit(cdkValidiumContract, "RevertLastVerifiedBatch")
                .withArgs(0, 1);

            // Should not be allowed to enter revert mode again. 
            await expect(cdkValidiumContract.revertLastVerifiedBatch())
                .to.be.revertedWith("notAllowedToRevertBatches");

            expect(await cdkValidiumContract.lastVerifiedBatch()).to.be.equal(ZERO_VALUE);
        });

        it("should prevent reverting a beyond the finality period", async () => {
            const pendingState = 0;
            
            const numBatch = (await cdkValidiumContract.lastVerifiedBatch()) + 1;
            
            await expect(
                cdkValidiumContract.connect(user).verifyBatches(
                    pendingState,
                    numBatch - 1,
                    numBatch,
                    newLocalExitRoot,
                    newStateRoot,
                    zkProofFFlonk,
                ),
            ).to.emit(cdkValidiumContract, 'VerifyBatches')
                .withArgs(numBatch, newStateRoot, user.address);

            currentTimestamp = (await ethers.provider.getBlock()).timestamp;

            await ethers.provider.send('evm_setNextBlockTimestamp', [currentTimestamp + FINALITY_PERIOD]);

            await expect(cdkValidiumContract.connect(user).enterRevertMode(forceBatchStruct1))
                .to.emit(cdkValidiumContract, 'ActivateRevertMode')
                .withArgs(user.address, 1);

            await expect(cdkValidiumContract.revertLastVerifiedBatch())
                .to.be.revertedWith("verifiedBeyondFinalityPeriod");
        });

        it("should rollback after verifying multiple batches", async () => {
            const l2txData = '0x123456';
            const transactionsHash = calculateBatchHashData(l2txData);
            const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

            // Get batch data
            const batchData1 = {
                transactionsHash,
                globalExitRoot: ethers.constants.HashZero,
                timestamp: ethers.BigNumber.from(currentTimestamp),
                minForcedTimestamp: 0
            }

            const batchData2 = {
                transactionsHash,
                globalExitRoot: ethers.constants.HashZero,
                timestamp: ethers.BigNumber.from(currentTimestamp),
                minForcedTimestamp: 0
            }

            // Get last batch sequenced
            const lastBatchSequenced = (await cdkValidiumContract.lastBatchSequenced()).toNumber();

            // Sequence batches
            await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches(
                    [batchData1,batchData2], l2CoinBase, [])
                )
                .to.emit(cdkValidiumContract, "SequenceBatches")
                .withArgs(lastBatchSequenced + 2);

           await expect(cdkValidiumContract.connect(user).enterRevertMode(forceBatchStruct1))
                .to.emit(cdkValidiumContract, 'ActivateRevertMode')
                .withArgs(user.address, 1);

            const pendingState = 0;
            const numBatch = (await cdkValidiumContract.lastVerifiedBatch()) + 1;

            await expect(
                cdkValidiumContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                    pendingState,
                    numBatch - 1,
                    numBatch,
                    newLocalExitRoot,
                    newStateRoot,
                    zkProofFFlonk,
                ),
            ).to.emit(cdkValidiumContract, 'VerifyBatchesTrustedAggregator')
                .withArgs(numBatch, newStateRoot, trustedAggregator.address);

            
            const initBatch = await cdkValidiumContract.lastVerifiedBatch();
            const endBatch = await cdkValidiumContract.lastBatchSequenced();
            
            newLocalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000002';
            newStateRoot = '0x0000000000000000000000000000000000000000000000000000000000000003';

            await expect(
                cdkValidiumContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                    0,
                    initBatch,
                    endBatch,
                    newLocalExitRoot,
                    newStateRoot,
                    zkProofFFlonk,
                ),
            ).to.emit(cdkValidiumContract, 'VerifyBatchesTrustedAggregator')
                .withArgs(3, newStateRoot, trustedAggregator.address);

            const lastVerifiedBatch = await cdkValidiumContract.lastVerifiedBatch();
            expect(lastVerifiedBatch).to.be.equal(3);

            const stateRootData = await cdkValidiumContract.stateRootData(lastVerifiedBatch);
            const oldStateRoot = stateRootData.oldStateRoot;

            await expect(cdkValidiumContract.revertLastVerifiedBatch()).not.to.be.reverted;

            const newLastVerifiedBatch = await cdkValidiumContract.lastVerifiedBatch();
            expect(newLastVerifiedBatch).to.be.equal(1);

            expect(await cdkValidiumContract.batchNumToStateRoot(newLastVerifiedBatch))
                .to.be.equal(oldStateRoot);

            // Trying to revert again during the same 
            await expect(cdkValidiumContract.revertLastVerifiedBatch())
                .to.be.revertedWith("notAllowedToRevertBatches");

        });
    });

    /*describe("Execute all forced transactions testing", () => {
        let l2txDataForceBatch;
        let maticAmount;
        let lastGlobalExitRoot;
        let currentTimestamp;
        let forceBatchStruct1;
        let newLocalExitRoot;
        let newStateRoot;
        let forcedBatchTimestamp;

        beforeEach('Build revert mode scenario', async () => {
            l2txDataForceBatch = '0x123456';
            maticAmount = await cdkValidiumContract.getForcedBatchFee();
            lastGlobalExitRoot = await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot();

            newLocalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000001';
            newStateRoot = '0x0000000000000000000000000000000000000000000000000000000000000002';

            // Activate force batches by admin role
            await expect(
                cdkValidiumContract.connect(admin).activateForceBatches(),
            ).to.emit(cdkValidiumContract, 'ActivateForceBatches');

            const lastForcedBatch = (await cdkValidiumContract.lastForceBatch()).toNumber();

            // lastForcedBatch should be equal to zero. 
            await expect(cdkValidiumContract.connect(user).forceBatch(l2txDataForceBatch, maticAmount))
                .to.emit(cdkValidiumContract, 'ForceBatch')
                .withArgs(lastForcedBatch + 1, lastGlobalExitRoot, user.address, '0x');

            forcedBatchTimestamp = (await ethers.provider.getBlock()).timestamp;

            expect((await cdkValidiumContract.lastForceBatch()).toNumber()).to.be.equal(1);

            // Verify batches and revert
            const l2txData = '0x123456';
            const transactionsHash = calculateBatchHashData(l2txData);
            const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

            // Get batch data
            const batchData1 = {
                transactionsHash,
                globalExitRoot: ethers.constants.HashZero,
                timestamp: ethers.BigNumber.from(currentTimestamp),
                minForcedTimestamp: 0
            }

            const batchData2 = {
                transactionsHash,
                globalExitRoot: ethers.constants.HashZero,
                timestamp: ethers.BigNumber.from(currentTimestamp),
                minForcedTimestamp: 0
            }

            // Get last batch sequenced
            const lastBatchSequenced = (await cdkValidiumContract.lastBatchSequenced()).toNumber();

            // Sequence batches
            await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches(
                    [batchData1,batchData2], l2CoinBase, [])
                )
                .to.emit(cdkValidiumContract, "SequenceBatches")
                .withArgs(lastBatchSequenced + 2);


            forceBatchStruct1 = {
                transactions: l2txDataForceBatch,
                globalExitRoot: lastGlobalExitRoot,
                minForcedTimestamp: forcedBatchTimestamp
            };

            await ethers.provider.send('evm_setNextBlockTimestamp', [currentTimestamp + FORCED_TX_WINDOW]);

            await expect(cdkValidiumContract.connect(user).enterRevertMode(forceBatchStruct1))
                .to.emit(cdkValidiumContract, 'ActivateRevertMode')
                .withArgs(user.address, 1);

            const pendingState = 0;
            const numBatch = (await cdkValidiumContract.lastVerifiedBatch()) + 1;

            await expect(
                cdkValidiumContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                    pendingState,
                    numBatch - 1,
                    numBatch,
                    newLocalExitRoot,
                    newStateRoot,
                    zkProofFFlonk,
                ),
            ).to.emit(cdkValidiumContract, 'VerifyBatchesTrustedAggregator')
                .withArgs(numBatch, newStateRoot, trustedAggregator.address);

            
            const initBatch = await cdkValidiumContract.lastVerifiedBatch();
            const endBatch = await cdkValidiumContract.lastBatchSequenced();
            
            newLocalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000002';
            newStateRoot = '0x0000000000000000000000000000000000000000000000000000000000000003';

            await expect(
                cdkValidiumContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                    0,
                    initBatch,
                    endBatch,
                    newLocalExitRoot,
                    newStateRoot,
                    zkProofFFlonk,
                ),
            ).to.emit(cdkValidiumContract, 'VerifyBatchesTrustedAggregator')
                .withArgs(3, newStateRoot, trustedAggregator.address);

            await expect(cdkValidiumContract.revertLastVerifiedBatch()).not.to.be.reverted;
        });

        it("should execute pending forced transaction", async () => {
            const transactionsHash = calculateBatchHashData(l2txDataForceBatch);
            const batchData = {
                transactionsHash,
                globalExitRoot: lastGlobalExitRoot,
                timestamp: ethers.BigNumber.from(forcedBatchTimestamp),
                minForcedTimestamp: forcedBatchTimestamp
            }
            
            
            // Execute pending forced batch.
            /*await expect(cdkValidiumContract.connect(user).executeAllForcedTransactions(
                    [batchData], newLocalExitRoot, newStateRoot, zkProofFFlonk))
                .to.emit(cdkValidiumContract, "ExecuteAllForcedTransactions")
                .withArgs(1,newStateRoot, user.address);
        }); 
    });*/
});
