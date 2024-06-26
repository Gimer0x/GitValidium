/* eslint-disable no-plusplus, no-await-in-loop */
const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

const { contractUtils } = require('@0xpolygonhermez/zkevm-commonjs');

const { calculateSnarkInput, calculateAccInputHash, calculateBatchHashData } = contractUtils;

describe('CDKValidium', () => {
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
    
   it("should allow trusted sequencer to sequence a batch", async () =>{
        const l2txData = '0x123456';
        const transactionsHash = calculateBatchHashData(l2txData);
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const batchData = {
            transactionsHash,
            globalExitRoot: ethers.constants.MaxUint256,
            timestamp: ethers.BigNumber.from(currentTimestamp),
            minForcedTimestamp: 0
        }

        const lastBatchSequenced = await cdkValidiumContract.lastBatchSequenced();

        expect(lastBatchSequenced).to.be.equal(ZERO_VALUE);

        // Not exists yet.
        const noSequencedBatchData = await cdkValidiumContract.sequencedBatches(1);

        // Check sequenced batch data mapping
        expect(noSequencedBatchData.accInputHash).to.be.equal(ethers.constants.HashZero);
        expect(noSequencedBatchData.sequencedTimestamp).to.be.equal(ZERO_VALUE);
        expect(noSequencedBatchData.previousLastBatchSequenced).to.be.equal(ZERO_VALUE);

        // Validate empty batch data
        await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches([], l2CoinBase, []))
            .to.be.revertedWith("SequenceZeroBatches");

        // Validate Global Exit Root
        await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches([batchData],l2CoinBase,[]))
            .to.be.revertedWith("GlobalExitRootNotExist");

        batchData.globalExitRoot = ethers.constants.HashZero;

        // Sequence a batch
        await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches([batchData],l2CoinBase,[]))
            .to.emit(cdkValidiumContract, "SequenceBatches")
            .withArgs(lastBatchSequenced + 1);

        // Validate sequenced batch mapping
        const sequencedBatchData = await cdkValidiumContract.sequencedBatches(1);

        const batchAccInputHash = sequencedBatchData.accInputHash;
        
        // Compute previous accumulated hash value
        const batchAccInputHashJs = calculateAccInputHash(
            (await cdkValidiumContract.sequencedBatches(0)).accInputHash,
            transactionsHash,
            batchData.globalExitRoot,
            batchData.timestamp,
            l2CoinBase,
        );

        const sequencedTimestamp = (await ethers.provider.getBlock()).timestamp;

        expect(batchAccInputHash).to.be.equal(batchAccInputHashJs);
        expect(sequencedBatchData.sequencedTimestamp).to.be.equal(sequencedTimestamp);
        expect(sequencedBatchData.previousLastBatchSequenced).to.be.equal(0);

    });

    it("should sequence multiple batches", async () => {
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
        const lastBatchSequenced = await cdkValidiumContract.lastBatchSequenced();

        // Sequence batches
        await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches(
                [batchData1,batchData2], l2CoinBase, [])
            )
            .to.emit(cdkValidiumContract, "SequenceBatches")
            .withArgs(lastBatchSequenced + 2);

        // Get accummulated hash.
        const sequencedBatchData2 = await cdkValidiumContract.sequencedBatches(2);
        const batchAccInputHash2 = sequencedBatchData2.accInputHash;

        // Calculate accumulated hash to verify batch mapping
        let batchAccInputHashJs = calculateAccInputHash(
            ethers.constants.HashZero,
            batchData1.transactionsHash,
            batchData1.globalExitRoot,
            batchData1.timestamp,
            l2CoinBase,
        );

        batchAccInputHashJs = calculateAccInputHash(
            batchAccInputHashJs,
            batchData2.transactionsHash,
            batchData2.globalExitRoot,
            batchData2.timestamp,
            l2CoinBase,
        );

        expect(batchAccInputHash2).to.be.equal(batchAccInputHashJs);

    });

    it("should force a batch", async () => {
        const l2txDataForceBatch = '0x123456';
        const maticAmount = await cdkValidiumContract.getForcedBatchFee();
        const lastGlobalExitRoot = await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot();

        // Activate forced batches
        await expect(
            cdkValidiumContract.connect(admin).activateForceBatches(),
        ).to.emit(cdkValidiumContract, 'ActivateForceBatches');

        // lastForceBatch should be equal to zero
        const lastForcedBatch = (await cdkValidiumContract.lastForceBatch()) + 1;

         await expect(cdkValidiumContract.connect(user).forceBatch(l2txDataForceBatch, maticAmount))
            .to.emit(cdkValidiumContract, 'ForceBatch')
            .withArgs(lastForcedBatch, lastGlobalExitRoot, user.address, '0x');
    });

    // Check this test --> Validate Force Batches
    it("should sequence multiple batches and force batches", async () => {
        const l2txDataForceBatch = '0x123456';
        const maticAmount = await cdkValidiumContract.getForcedBatchFee();
        const lastGlobalExitRoot = await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot();

        // Activate forced batches
        await expect(
            cdkValidiumContract.connect(admin).activateForceBatches(),
        ).to.emit(cdkValidiumContract, 'ActivateForceBatches');

        const lastForcedBatch = (await cdkValidiumContract.lastForceBatch()) + 1;

        // Force batch
        await expect(cdkValidiumContract.connect(user).forceBatch(l2txDataForceBatch, maticAmount))
            .to.emit(cdkValidiumContract, 'ForceBatch')
            .withArgs(lastForcedBatch, lastGlobalExitRoot, user.address, '0x');
        
        // Sequence two batches
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

        // Why global exit root can be equal to hash zero?
        const batchData2 = {
            transactionsHash,
            globalExitRoot: ethers.constants.HashZero,
            timestamp: ethers.BigNumber.from(currentTimestamp),
            minForcedTimestamp: 0
        }

        const lastBatchSequenced = await cdkValidiumContract.lastBatchSequenced();

        // Check batch mapping
        const batchAccInputHash = (await cdkValidiumContract.sequencedBatches(1)).accInputHash;

        // Only last batch is added to the mapping (forced batch).
        expect(batchAccInputHash).to.be.equal(ethers.constants.HashZero);

        await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches(
                [batchData1, batchData2], trustedSequencer.address, [])
            )
            .to.emit(cdkValidiumContract, 'SequenceBatches')
            .withArgs(lastBatchSequenced + 2);

        // Check input hash
        let batchAccInputHash1 = calculateAccInputHash(
            ethers.constants.HashZero,
            batchData1.transactionsHash,
            batchData1.globalExitRoot,
            batchData1.timestamp,
            trustedSequencer.address,
        );

        // Calcultate input Hahs for batch 2
        let batchAccInputHash2 = calculateAccInputHash(
            batchAccInputHash1,
            batchData2.transactionsHash,
            batchData2.globalExitRoot,
            batchData2.timestamp,
            trustedSequencer.address,
        );
        const secondBatchData = await cdkValidiumContract.sequencedBatches(2);

        expect(secondBatchData.accInputHash).to.be.equal(batchAccInputHash2);
        expect(secondBatchData.previousLastBatchSequenced).to.be.equal(ZERO_VALUE);
    });

    it("Should check force batch data timestamp", async () => {
        const l2txDataForceBatch = '0x123456';
        const transactionsHashForceBatch = calculateBatchHashData(l2txDataForceBatch);
        const maticAmount = await cdkValidiumContract.getForcedBatchFee();
        const lastGlobalExitRoot = await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot();
        const lastForcedBatch = (await cdkValidiumContract.lastForceBatch()) + 1;

        // Activate forced batches
        await expect(
            cdkValidiumContract.connect(admin).activateForceBatches(),
        ).to.emit(cdkValidiumContract, 'ActivateForceBatches');

        // Force batch
        await expect(cdkValidiumContract.connect(user).forceBatch(l2txDataForceBatch, maticAmount))
            .to.emit(cdkValidiumContract, 'ForceBatch')
            .withArgs(lastForcedBatch, lastGlobalExitRoot, user.address, '0x');

        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;
        const batchData = {
            transactionsHash: transactionsHashForceBatch,
            globalExitRoot: lastGlobalExitRoot,
            timestamp: currentTimestamp,
            minForcedTimestamp: currentTimestamp
        }
        
         // Assert that the timestamp requirements must accomplish with force batches too
        batchData.minForcedTimestamp += 1;
        await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches(
                [batchData], trustedSequencer.address, [])
            )
            .to.be.revertedWith('ForcedDataDoesNotMatch');
        batchData.minForcedTimestamp -= 1;
        
        batchData.timestamp -= 1;
        await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches(
                [batchData], trustedSequencer.address, [])
            )
            .to.be.revertedWith('SequencedTimestampBelowForcedTimestamp');
        batchData.timestamp += 1;

        batchData.timestamp = currentTimestamp + 10;
        await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches(
                [batchData], trustedSequencer.address, [])
            )
            .to.be.revertedWith('SequencedTimestampInvalid');
        batchData.timestamp = currentTimestamp;

        const lastBatchSequenced = await cdkValidiumContract.lastBatchSequenced();

        await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches(
                [batchData], trustedSequencer.address, [])
            )
            .to.emit(cdkValidiumContract, 'SequenceBatches')
            .withArgs(lastBatchSequenced.add(1));

        const sequencedTimestamp = (await ethers.provider.getBlock()).timestamp;
        
        // Calcultate input Hahs for batch 2
        let batchAccInputHashJs = calculateAccInputHash(
            ethers.constants.HashZero,
            batchData.transactionsHash,
            batchData.globalExitRoot,
            batchData.timestamp,
            trustedSequencer.address,
        );

        const batchData1 = await cdkValidiumContract.sequencedBatches(1);
        expect(batchData1.accInputHash).to.be.equal(batchAccInputHashJs);
        expect(batchData1.sequencedTimestamp).to.be.equal(sequencedTimestamp);
        expect(batchData1.previousLastBatchSequenced).to.be.equal(0);
    });

    it("Should use sequenceForceBatches to sequence force batches", async () => {
        const l2txData = '0x123456';
        const feeAmount = await cdkValidiumContract.getForcedBatchFee();
        const lastGlobalExitRoot = await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot();

        // Activate force batches
        await expect(
            cdkValidiumContract.connect(admin).activateForceBatches(),
        ).to.emit(cdkValidiumContract, 'ActivateForceBatches');

        const lastForcedBatch = (await cdkValidiumContract.lastForceBatch()) + 1;

        await expect(cdkValidiumContract.connect(user).forceBatch(l2txData, feeAmount))
            .to.emit(cdkValidiumContract, 'ForceBatch')
            .withArgs(lastForcedBatch, lastGlobalExitRoot, user.address, '0x');

        // Check storage variables before call
        expect(await cdkValidiumContract.lastForceBatchSequenced()).to.be.equal(0);
        expect(await cdkValidiumContract.lastBatchSequenced()).to.be.equal(0);
        expect(await cdkValidiumContract.lastForceBatch()).to.be.equal(1);

        const timestampForceBatch = (await ethers.provider.getBlock()).timestamp;
        
        const forceBatchStruct = {
            transactions: l2txData,
            globalExitRoot: lastGlobalExitRoot,
            minForcedTimestamp: timestampForceBatch,
        };

        // Increment timestamp + ForceBatchTimeOut (5 days)
        await ethers.provider.send('evm_setNextBlockTimestamp', [timestampForceBatch + FORCE_BATCH_TIMEOUT]);

        await expect(cdkValidiumContract.connect(user).sequenceForceBatches([forceBatchStruct]))
            .to.emit(cdkValidiumContract, 'SequenceForceBatches')
            .withArgs(1);

        const timestampSequenceBatch = (await ethers.provider.getBlock()).timestamp;

        // Check storage variables after call
        expect(await cdkValidiumContract.lastForceBatchSequenced()).to.be.equal(1);
        expect(await cdkValidiumContract.lastBatchSequenced()).to.be.equal(1);
        expect(await cdkValidiumContract.lastForceBatch()).to.be.equal(1);

         // Check force batches struct
        const batchAccInputHash = (await cdkValidiumContract.sequencedBatches(1)).accInputHash;

        const batchAccInputHashJs = calculateAccInputHash(
            ethers.constants.HashZero,
            calculateBatchHashData(l2txData),
            lastGlobalExitRoot,
            timestampSequenceBatch,
            user.address,
        );
        expect(batchAccInputHash).to.be.equal(batchAccInputHashJs);
    });

    it("Should force a batch through smart contract", async () => {
        const l2txDataForceBatch = '0x123456';
        const maticAmount = ethers.utils.parseEther('100');
        const lastGlobalExitRoot = await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot();

        // deploy send data mock contract
        const sendDataFactory = await ethers.getContractFactory('SendData');
        const sendDataContract = await sendDataFactory.deploy();
        await sendDataContract.deployed();

        // transfer matic to contract to pay for fees
        await maticTokenContract.transfer(sendDataContract.address, maticAmount);

        const approveTx = await maticTokenContract.populateTransaction.approve(cdkValidiumContract.address, maticAmount);
        
        await sendDataContract.sendData(approveTx.to, approveTx.data);

        // Activate forced batches
        await expect(
            cdkValidiumContract.connect(admin).activateForceBatches(),
        ).to.emit(cdkValidiumContract, 'ActivateForceBatches');

        const lastForcedBatch = (await cdkValidiumContract.lastForceBatch()) + 1;

        const forceBatchTx = await cdkValidiumContract.populateTransaction.forceBatch(l2txDataForceBatch, maticAmount);
        
        await expect(sendDataContract.sendData(forceBatchTx.to, forceBatchTx.data))
            .to.emit(cdkValidiumContract, 'ForceBatch')
            .withArgs(lastForcedBatch, lastGlobalExitRoot, sendDataContract.address, l2txDataForceBatch);
    });

    it('should verify a sequenced batch using verifyBatchesTrustedAggregator', async () => {
        const l2txData = '0x123456';
        const transactionsHash = calculateBatchHashData(l2txData);
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const batchData = {
            transactionsHash,
            globalExitRoot: ethers.constants.HashZero,
            timestamp: currentTimestamp,
            minForcedTimestamp: 0,
        };

        const lastBatchSequenced = await cdkValidiumContract.lastBatchSequenced();
        // Sequence Batches
        await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches([batchData], trustedSequencer.address, []))
            .to.emit(cdkValidiumContract, 'SequenceBatches')
            .withArgs(lastBatchSequenced + 1);

        // Allows an aggregator to verify multiple batches
        const pendingState = 0;
        const newLocalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000000';
        const newStateRoot = '0x0000000000000000000000000000000000000000000000000000000000000000';
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
    });

    it('should verify a force sequenced batch using verifyBatchesTrustedAggregator', async () => { 
        const l2txData = '0x123456';
        const maticFees = await cdkValidiumContract.getForcedBatchFee();
        const lastGlobalExitRoot = await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot();

        // Activate force batches
        await expect(
            cdkValidiumContract.connect(admin).activateForceBatches(),
        ).to.emit(cdkValidiumContract, 'ActivateForceBatches');

        const lastForcedBatch = (await cdkValidiumContract.lastForceBatch()) + 1;
        // MaticAmount: Max amount of MATIC tokens that the sender is willing to pay
        await expect(cdkValidiumContract.connect(user).forceBatch(l2txData, maticFees))
            .to.emit(cdkValidiumContract, 'ForceBatch')
            .withArgs(lastForcedBatch, lastGlobalExitRoot, user.address, '0x');

        const timestampForceBatch = (await ethers.provider.getBlock()).timestamp;

        // Increment timestamp
        await ethers.provider.send('evm_setNextBlockTimestamp', [timestampForceBatch + FORCE_BATCH_TIMEOUT]);

        const forceBatchStruct = {
            transactions: l2txData,
            globalExitRoot: lastGlobalExitRoot,
            minForcedTimestamp: timestampForceBatch,
        };

        // sequence force batch
        await expect(cdkValidiumContract.connect(user).sequenceForceBatches([forceBatchStruct]))
            .to.emit(cdkValidiumContract, 'SequenceForceBatches')
            .withArgs(lastForcedBatch);

         // trustedAggregator forge the batch
        const pendingState = 0;
        const newLocalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000000';
        const newStateRoot = '0x0000000000000000000000000000000000000000000000000000000000000000';
        const numBatch = (await cdkValidiumContract.lastVerifiedBatch()) + 1;
        
        const initialAggregatorMatic = await maticTokenContract.balanceOf(
            trustedAggregator.address,
        );

        // Verify batch
        await expect(
            cdkValidiumContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                pendingState,
                numBatch - 1,
                numBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(cdkValidiumContract, 'VerifyBatch')
            .withArgs(numBatch, trustedAggregator.address)
            .to.emit(maticTokenContract, 'Transfer')
            .withArgs(cdkValidiumContract.address, trustedAggregator.address, maticFees);

        const finalAggregatorMatic = await maticTokenContract.balanceOf(
            trustedAggregator.address,
        );

        expect(finalAggregatorMatic).to.equal(
            ethers.BigNumber.from(initialAggregatorMatic).add(ethers.BigNumber.from(maticFees)),
        );

    });

    it('should verify a sequenced batch using verifyBatches', async () => { 
        const l2txData = '0x123456';
        const transactionsHash = calculateBatchHashData(l2txData);
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const batchData = {
            transactionsHash,
            globalExitRoot: ethers.constants.HashZero,
            timestamp: currentTimestamp,
            minForcedTimestamp: 0,
        };

        const lastBatchSequenced = await cdkValidiumContract.lastBatchSequenced();

        // Sequence Batches
        await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches(
                [batchData], trustedSequencer.address, [])
            )
            .to.emit(cdkValidiumContract, 'SequenceBatches')
            .withArgs(lastBatchSequenced + 1);


        // Aggregator verifies the batch
        const pendingState = 0;
        const newLocalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000001';
        const newStateRoot = '0x0000000000000000000000000000000000000000000000000000000000000002';
        const numBatch = (await cdkValidiumContract.lastVerifiedBatch()) + 1;
        
        const sequencedBatchData = await cdkValidiumContract.sequencedBatches(1);
        const { sequencedTimestamp } = sequencedBatchData;

        await expect(
            cdkValidiumContract.connect(aggregator1).verifyBatches(
                pendingState,
                numBatch - 1,
                numBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('TrustedAggregatorTimeoutNotExpired');

        await ethers.provider.send('evm_setNextBlockTimestamp', [
                sequencedTimestamp.toNumber() + trustedAggregatorTimeoutDefault
        ]);

         await expect(
            cdkValidiumContract.connect(aggregator1).verifyBatches(
                pendingState,
                numBatch - 1,
                numBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(cdkValidiumContract, 'VerifyBatches')
         .withArgs(numBatch, newStateRoot, aggregator1.address);
    });
    

    it("should test pending state", async () => {
        const l2txData = '0x123456';
        const transactionsHash = calculateBatchHashData(l2txData);
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const batchesForSequence = 5;
        const batchData = {
            transactionsHash,
            globalExitRoot: ethers.constants.HashZero,
            timestamp: currentTimestamp,
            minForcedTimestamp: 0,
        };
        const sequencesArray = Array(batchesForSequence).fill(batchData);
        console.log(sequencesArray.length);

        // Make 20 sequences of 5 batches, with 1 minut timestamp difference
        for (let i = 0; i < 20; i++) {
            await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches(sequencesArray, trustedSequencer.address, []))
                .to.emit(cdkValidiumContract, 'SequenceBatches');
            await ethers.provider.send('evm_increaseTime', [60]);
        }
        
        // Forge first sequence with verifyBatches
        const newLocalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000001';
        const newStateRoot = '0x0000000000000000000000000000000000000000000000000000000000000002';
        const zkProofFFlonk = new Array(24).fill(ethers.constants.HashZero);

        let currentPendingState = 0;
        let currentNumBatch = 0;
        let newBatch = currentNumBatch + batchesForSequence;

        // Verify batch --> 0 to 5
        await expect(
            cdkValidiumContract.connect(aggregator1).verifyBatches(
                currentPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(cdkValidiumContract, 'VerifyBatches')
            .withArgs(newBatch, newStateRoot, aggregator1.address);

        let verifyTimestamp = (await ethers.provider.getBlock()).timestamp;

        // Check pending state to be equal to one. 
        currentPendingState++;
        expect(currentPendingState).to.be.equal(await cdkValidiumContract.lastPendingState());

        let currentPendingStateData = await cdkValidiumContract.pendingStateTransitions(currentPendingState);

        expect(verifyTimestamp).to.be.equal(currentPendingStateData.timestamp);
        expect(newBatch).to.be.equal(currentPendingStateData.lastVerifiedBatch);
        expect(newLocalExitRoot).to.be.equal(currentPendingStateData.exitRoot);
        expect(newStateRoot).to.be.equal(currentPendingStateData.stateRoot);

        // Try to verify Batches that does not go beyond the last pending state
        // Trying to verify batches from 0 to 5. 
        await expect(
            cdkValidiumContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                0,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('FinalNumBatchBelowLastVerifiedBatch');

        // Should fail because pending state is equal to one not two.
        await expect(
            cdkValidiumContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                2,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('PendingStateDoesNotExist');

        // The currentNumBatch is different from the last verified batch in the current pending state.
        await expect(
            cdkValidiumContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                currentPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk
            ),
        ).to.be.revertedWith('InitNumBatchDoesNotMatchPendingState');

        // Verify the next sequence of batches using verifyBatchesTrustedAggregator
        // Clean pending state if any
        currentNumBatch = newBatch;
        newBatch += batchesForSequence;
        console.log("currentNumBatch: ", currentNumBatch);
        console.log("newBatch: ", newBatch);
        console.log("currentPendingState", currentPendingState);
        await expect(
            cdkValidiumContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                currentPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk
            ),
        ).to.emit(cdkValidiumContract, 'VerifyBatchesTrustedAggregator')
            .withArgs(newBatch, newStateRoot, trustedAggregator.address);

        // Check if the pending state is clear after calling verifyBatchesTrustedAggregator
        currentPendingState = 0;
        expect(currentPendingState).to.be.equal(await cdkValidiumContract.lastPendingState());
        expect(0).to.be.equal(await cdkValidiumContract.lastPendingStateConsolidated());

        // Check consolidated state
        let currentVerifiedBatch = newBatch;
        expect(currentVerifiedBatch).to.be.equal(await cdkValidiumContract.lastVerifiedBatch());
        expect(newStateRoot).to.be.equal(await cdkValidiumContract.batchNumToStateRoot(currentVerifiedBatch));

        // Pending state should not exist because it was already cleared. 
        await expect(
            cdkValidiumContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                1,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('PendingStateDoesNotExist');
        console.log("currentNumBatch: ", currentNumBatch)
        // Since this pending state was not consolidated, the currentNumBatch does not have stored root
        expect(ethers.constants.HashZero).to.be.equal(await cdkValidiumContract.batchNumToStateRoot(currentNumBatch));
        
        await expect(
            cdkValidiumContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                currentPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('OldStateRootDoesNotExist');

        await expect(
            cdkValidiumContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                currentPendingState,
                0,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('FinalNumBatchBelowLastVerifiedBatch');

        // currentNumBatch and newBatch should be equal to 10 and 15.
        currentNumBatch = newBatch;
        newBatch += batchesForSequence;
        await expect(
            cdkValidiumContract.connect(aggregator1).verifyBatches(
                currentPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(cdkValidiumContract, 'VerifyBatches')
            .withArgs(newBatch, newStateRoot, aggregator1.address);

        // Check pending state
        verifyTimestamp = (await ethers.provider.getBlock()).timestamp;

        currentPendingState++;
        console.log("Last Pending: ", await cdkValidiumContract.lastPendingState());

        // Current pending state should be equal to one. 
        currentPendingStateData = await cdkValidiumContract.pendingStateTransitions(currentPendingState);
        expect(verifyTimestamp).to.be.equal(currentPendingStateData.timestamp);
        expect(newBatch).to.be.equal(currentPendingStateData.lastVerifiedBatch);
        expect(newLocalExitRoot).to.be.equal(currentPendingStateData.exitRoot);
        expect(newStateRoot).to.be.equal(currentPendingStateData.stateRoot);


        console.log("Consolidated: ", await cdkValidiumContract.lastPendingStateConsolidated());

        // Verify another sequence from batch 0
        currentNumBatch = newBatch;
        newBatch += batchesForSequence;

        await expect(
            cdkValidiumContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                0,
                1,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('OldStateRootDoesNotExist');

        await expect(
            cdkValidiumContract.connect(aggregator1).verifyBatches(
                0,
                0,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(cdkValidiumContract, 'VerifyBatches')
            .withArgs(newBatch, newStateRoot, aggregator1.address);

        // Check pending state
        verifyTimestamp = (await ethers.provider.getBlock()).timestamp;
        console.log("New pending: ", await cdkValidiumContract.lastPendingState());
        currentPendingState++;
        expect(currentPendingState).to.be.equal(await cdkValidiumContract.lastPendingState());

        currentPendingStateData = await cdkValidiumContract.pendingStateTransitions(currentPendingState);
        expect(verifyTimestamp).to.be.equal(currentPendingStateData.timestamp);
        expect(newBatch).to.be.equal(currentPendingStateData.lastVerifiedBatch);
        expect(newLocalExitRoot).to.be.equal(currentPendingStateData.exitRoot);
        expect(newStateRoot).to.be.equal(currentPendingStateData.stateRoot);
        
        // Verify batches using old pending state
        currentNumBatch = newBatch;
        newBatch += batchesForSequence;

        console.log(currentNumBatch);
        console.log(newBatch);
        // Must specify pending state num while is not consolidated
        await expect(
            cdkValidiumContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                0,
                currentNumBatch - 5,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('OldStateRootDoesNotExist');

        console.log(currentPendingState);
        await expect(
            cdkValidiumContract.connect(aggregator1).verifyBatches(
                currentPendingState - 1,
                currentNumBatch - 5,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(cdkValidiumContract, 'VerifyBatches')
            .withArgs(newBatch, newStateRoot, aggregator1.address);

        verifyTimestamp = (await ethers.provider.getBlock()).timestamp;
        currentPendingState++;
        expect(currentPendingState).to.be.equal(await cdkValidiumContract.lastPendingState());

        currentPendingStateData = await cdkValidiumContract.pendingStateTransitions(currentPendingState);
        expect(verifyTimestamp).to.be.equal(currentPendingStateData.timestamp);
        expect(newBatch).to.be.equal(currentPendingStateData.lastVerifiedBatch);
        console.log(currentPendingStateData.lastVerifiedBatch);
        expect(newLocalExitRoot).to.be.equal(currentPendingStateData.exitRoot);
        expect(newStateRoot).to.be.equal(currentPendingStateData.stateRoot);

        // Consolidate using verifyBatches
        const firstPendingState = await cdkValidiumContract.pendingStateTransitions(1);
        await ethers.provider.send('evm_setNextBlockTimestamp', [firstPendingState.timestamp.toNumber() + pendingStateTimeoutDefault]);

        let currentPendingConsolidated = 0;
        currentNumBatch = newBatch;
        newBatch += batchesForSequence;

        console.log("currentPendingState 2: ", currentPendingState)
        await expect(
            cdkValidiumContract.connect(aggregator1).verifyBatches(
                currentPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(cdkValidiumContract, 'VerifyBatches')
            .withArgs(newBatch, newStateRoot, aggregator1.address)
            .to.emit(cdkValidiumContract, 'ConsolidatePendingState')
            .withArgs(firstPendingState.lastVerifiedBatch, newStateRoot, ++currentPendingConsolidated);

        verifyTimestamp = (await ethers.provider.getBlock()).timestamp;
        currentPendingState++;
        console.log("Last Pending: ", await cdkValidiumContract.lastPendingState());
        expect(currentPendingState).to.be.equal(await cdkValidiumContract.lastPendingState());
        console.log(await cdkValidiumContract.lastPendingStateConsolidated());
        expect(currentPendingConsolidated).to.be.equal(await cdkValidiumContract.lastPendingStateConsolidated());

        currentPendingStateData = await cdkValidiumContract.pendingStateTransitions(currentPendingState);
        expect(verifyTimestamp).to.be.equal(currentPendingStateData.timestamp);
        expect(newBatch).to.be.equal(currentPendingStateData.lastVerifiedBatch);
        expect(newLocalExitRoot).to.be.equal(currentPendingStateData.exitRoot);
        expect(newStateRoot).to.be.equal(currentPendingStateData.stateRoot);

        // Check state consolidated
        currentVerifiedBatch += batchesForSequence;
        console.log("currentVerifiedBatch:", currentVerifiedBatch);
        expect(currentVerifiedBatch).to.be.equal(await cdkValidiumContract.lastVerifiedBatch());
        expect(newStateRoot).to.be.equal(await cdkValidiumContract.batchNumToStateRoot(currentVerifiedBatch));

        // Consolidate using sendBatches
        const secondPendingState = await cdkValidiumContract.pendingStateTransitions(2);
        await ethers.provider.send('evm_setNextBlockTimestamp', [secondPendingState.timestamp.toNumber() + pendingStateTimeoutDefault]);

        
        await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches(sequencesArray, trustedSequencer.address, []))
            .to.emit(cdkValidiumContract, 'SequenceBatches')
            .to.emit(cdkValidiumContract, 'ConsolidatePendingState')
            .withArgs(secondPendingState.lastVerifiedBatch, newStateRoot, ++currentPendingConsolidated);

        console.log("currentPendingConsolidated: ", currentPendingConsolidated);

        expect(currentPendingState).to.be.equal(await cdkValidiumContract.lastPendingState());
        expect(currentPendingConsolidated).to.be.equal(await cdkValidiumContract.lastPendingStateConsolidated());

        // Check state consolidated
        currentVerifiedBatch += batchesForSequence;
        expect(currentVerifiedBatch).to.be.equal(await cdkValidiumContract.lastVerifiedBatch());
        console.log("Last verified batch: ", await cdkValidiumContract.lastVerifiedBatch())
        expect(newStateRoot).to.be.equal(await cdkValidiumContract.batchNumToStateRoot(currentVerifiedBatch));

        // Put a lot of pending states and check that half of them are consoldiated
        for (let i = 0; i < 8; i++) {
            currentNumBatch = newBatch;
            newBatch += batchesForSequence;
            await expect(
                cdkValidiumContract.connect(aggregator1).verifyBatches(
                    currentPendingState,
                    currentNumBatch,
                    newBatch,
                    newLocalExitRoot,
                    newStateRoot,
                    zkProofFFlonk,
                ),
            ).to.emit(cdkValidiumContract, 'VerifyBatches')
                .withArgs(newBatch, newStateRoot, aggregator1.address);

            currentPendingState++;
        }
        console.log("currentPendingState After Loop: ", currentPendingState);

        expect(currentPendingState).to.be.equal(await cdkValidiumContract.lastPendingState());

        currentPendingConsolidated = await cdkValidiumContract.lastPendingStateConsolidated();
        const lastPendingState = await cdkValidiumContract.pendingStateTransitions(currentPendingState);
        // console.log("lastPendingState: ", lastPendingState);
        await ethers.provider.send('evm_setNextBlockTimestamp', [lastPendingState.timestamp.toNumber() + pendingStateTimeoutDefault]);

        
        // call verify batches and check that half of them are consolidated
        expect(currentPendingState).to.be.equal(await cdkValidiumContract.lastPendingState());
        expect(currentPendingConsolidated).to.be.equal(await cdkValidiumContract.lastPendingStateConsolidated());
        console.log("currentPendingConsolidated: ", currentPendingConsolidated);

        const nextPendingConsolidated = Number(currentPendingConsolidated) + 1;
        const nextConsolidatedStateNum = nextPendingConsolidated + Number(Math.floor((currentPendingState - nextPendingConsolidated) / 2));
        const nextConsolidatedState = await cdkValidiumContract.pendingStateTransitions(nextConsolidatedStateNum);

        await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches(sequencesArray, trustedSequencer.address, []))
            .to.emit(cdkValidiumContract, 'SequenceBatches')
            .to.emit(cdkValidiumContract, 'ConsolidatePendingState')
            .withArgs(nextConsolidatedState.lastVerifiedBatch, newStateRoot, nextConsolidatedStateNum);

        // Put pendingState to 0 and check that the pending state is clear after verifyBatches
        await expect(
            cdkValidiumContract.connect(admin).setPendingStateTimeout(0),
        ).to.emit(cdkValidiumContract, 'SetPendingStateTimeout').withArgs(0);

        currentNumBatch = newBatch;
        newBatch += batchesForSequence;
        await expect(
            cdkValidiumContract.connect(aggregator1).verifyBatches(
                currentPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(cdkValidiumContract, 'VerifyBatches')
            .withArgs(newBatch, newStateRoot, aggregator1.address);

        currentPendingState = 0;
        expect(currentPendingState).to.be.equal(await cdkValidiumContract.lastPendingState());
        expect(0).to.be.equal(await cdkValidiumContract.lastPendingStateConsolidated());

        currentVerifiedBatch = newBatch;
        expect(currentVerifiedBatch).to.be.equal(await cdkValidiumContract.lastVerifiedBatch());
        expect(newStateRoot).to.be.equal(await cdkValidiumContract.batchNumToStateRoot(currentVerifiedBatch));
    });

    it("Anyone should activate emergency state due halt timeout", async () => {
        const l2txData = '0x123456';
        const transactionsHash = calculateBatchHashData(l2txData);
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const batchData = {
            transactionsHash,
            globalExitRoot: ethers.constants.HashZero,
            timestamp: ethers.BigNumber.from(currentTimestamp),
            minForcedTimestamp: 0
        };

        const lastBatchSequenced = 1;
        await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches([batchData], trustedSequencer.address, []))
            .to.emit(cdkValidiumContract, 'SequenceBatches')
            .withArgs(lastBatchSequenced);

        const sequencedTimestmap = Number((await cdkValidiumContract.sequencedBatches(1)).sequencedTimestamp);
        const haltTimeout = HALT_AGGREGATION_TIMEOUT;

        // Activate the emergency state
        await expect(cdkValidiumContract.connect(user).activateEmergencyState(2))
            .to.be.revertedWith('BatchNotSequencedOrNotSequenceEnd');

        // Check batch is already verified (Mocking)
        await cdkValidiumContract.setVerifiedBatch(1);
        await expect(cdkValidiumContract.connect(user).activateEmergencyState(1))
            .to.be.revertedWith('BatchAlreadyVerified');
        await cdkValidiumContract.setVerifiedBatch(0);

        // check timeout is not expired
        await expect(cdkValidiumContract.connect(user).activateEmergencyState(1))
            .to.be.revertedWith('HaltTimeoutNotExpired');

        await ethers.provider.send('evm_setNextBlockTimestamp', [sequencedTimestmap + haltTimeout]);

        // Activate emergency state
        await expect(cdkValidiumContract.connect(user).activateEmergencyState(1))
            .to.emit(cdkValidiumContract, 'EmergencyStateActivated');
    })
});

