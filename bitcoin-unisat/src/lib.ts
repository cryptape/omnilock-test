import { BI, Cell, helpers, Indexer, RPC, config, commons } from "../../lumos/packages/lumos";
import { omnilock } from "../../lumos/packages/lumos/common-scripts";
import { blockchain, bytify, hexify } from "../../lumos/packages/lumos/codec";
import { CONFIG } from ".";

// const CKB_RPC_URL_TestNet = "https://testnet.ckb.dev";
const CKB_RPC_URL_MainNet = "https://mainnet.ckb.dev/";
// const CKB_RPC_URL_DevNet = "http://127.0.0.1:8128";
const rpc = new RPC(CKB_RPC_URL_MainNet);
const indexer = new Indexer(CKB_RPC_URL_MainNet);

//todo account request
declare global {
    interface Window {
        unisat: omnilock.bitcoin.Provider;
    }
}

export const unisat = window.unisat;

export function asyncSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Options {
    from: string;
    to: string;
    amount: string;
}
const SECP_SIGNATURE_PLACEHOLDER = hexify(
    new Uint8Array(
        commons.omnilock.OmnilockWitnessLock.pack({
            signature: new Uint8Array(65).buffer,
        }).byteLength
    )
);

export async function transfer(options: Options): Promise<string> {
    // const CONFIG = config.getConfig();
    let tx = helpers.TransactionSkeleton({});
    const fromScript = helpers.parseAddress(options.from);
    const toScript = helpers.parseAddress(options.to);

    // additional 0.001 ckb for tx fee
    // the tx fee could calculate by tx size
    // this is just a simple example
    const neededCapacity = BI.from(options.amount).add(100000);
    let collectedSum = BI.from(0);
    const collectedCells: Cell[] = [];
    const collector = indexer.collector({ lock: fromScript, type: "empty" });
    for await (const cell of collector.collect()) {
        collectedSum = collectedSum.add(cell.cellOutput.capacity);
        collectedCells.push(cell);
        if (BI.from(collectedSum).gte(neededCapacity)) break;
    }

    if (collectedSum.lt(neededCapacity)) {
        throw new Error(`Not enough CKB, expected: ${neededCapacity}, actual: ${collectedSum} `);
    }

    const transferOutput: Cell = {
        cellOutput: {
            capacity: BI.from(options.amount).toHexString(),
            lock: toScript,
        },
        data: "0x",
    };

    const changeOutput: Cell = {
        cellOutput: {
            capacity: collectedSum.sub(neededCapacity).toHexString(),
            lock: fromScript,
        },
        data: "0x",
    };

    tx = tx.update("inputs", (inputs) => inputs.push(...collectedCells));
    tx = tx.update("outputs", (outputs) => outputs.push(transferOutput, changeOutput));
    tx = tx.update("cellDeps", (cellDeps) =>
        cellDeps.push(
            // omni lock dep
            {
                outPoint: {
                    txHash: CONFIG.SCRIPTS.OMNILOCK.TX_HASH,
                    index: CONFIG.SCRIPTS.OMNILOCK.INDEX,
                },
                depType: CONFIG.SCRIPTS.OMNILOCK.DEP_TYPE,
            },
            // SECP256K1 lock is depended by omni lock
            {
                outPoint: {
                    txHash: CONFIG.SCRIPTS.SECP256K1_BLAKE160.TX_HASH,
                    index: CONFIG.SCRIPTS.SECP256K1_BLAKE160.INDEX,
                },
                depType: CONFIG.SCRIPTS.SECP256K1_BLAKE160.DEP_TYPE,
            }
        )
    );

    const witness = hexify(blockchain.WitnessArgs.pack({ lock: SECP_SIGNATURE_PLACEHOLDER }));

    // fill txSkeleton's witness with placeholder
    for (let i = 0; i < tx.inputs.toArray().length; i++) {
        tx = tx.update("witnesses", (witnesses) => witnesses.push(witness));
    }

    tx = commons.omnilock.prepareSigningEntries(tx, { config: CONFIG });
    const signedMessage = await omnilock.bitcoin.signMessage(tx.signingEntries.get(0).message, "ecdsa", window.unisat);

    const signedWitness = hexify(
        blockchain.WitnessArgs.pack({
            lock: commons.omnilock.OmnilockWitnessLock.pack({
                signature: bytify(signedMessage).buffer,
            }),
        })
    );

    tx = tx.update("witnesses", (witnesses) => witnesses.set(0, signedWitness));

    const signedTx = helpers.createTransactionFromSkeleton(tx);
    const txHash = await rpc.sendTransaction(signedTx, "passthrough");

    return txHash;
}

export async function capacityOf(address: string): Promise<BI> {
    const collector = indexer.collector({
        lock: helpers.parseAddress(address),
    });

    let balance = BI.from(0);
    for await (const cell of collector.collect()) {
        balance = balance.add(cell.cellOutput.capacity);
    }

    return balance;
}