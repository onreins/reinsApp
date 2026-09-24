# Arbiter run on Arc testnet

`ArbitratedEscrow` at [`0xdcfaf4d8be9eedf12fe4b0b4ceafb9d1d580f794`](https://explorer.testnet.arc.io/address/0xdcfaf4d8be9eedf12fe4b0b4ceafb9d1d580f794), settled by rulings from the
Verdict arbiter API (`arbiter/app.js`), signed by `0x668640c4f897F55661139D153Feee8b989d5d100`. Each
ruling carries an EIP-712 attestation that the contract verified on-chain before moving funds.

## working code: passed (3/3 tests passed)

Case `0x2a765b7062c75613958767a12b69c846d4553290c5813ebb96410f071d15511d`. The contract paid the seller $0.0500; the seller submitted the ruling and paid $0.0020 gas (on Arc, gas is paid in USDC).
Ruling hash `0xe2ef0ea6fab2b4027e3b8280517d8f1f891383fe7923617ee7a1029cdad71fbf`, saved as [ruling-0xe2ef0ea6fab2b4027e3b8280517d8f1f891383fe7923617ee7a1029cdad71fbf.json](ruling-0xe2ef0ea6fab2b4027e3b8280517d8f1f891383fe7923617ee7a1029cdad71fbf.json).

| step | transaction |
|---|---|
| `approve` | [`0xb5d32cd96ef8ae35…`](https://explorer.testnet.arc.io/tx/0xb5d32cd96ef8ae352a568eaabebdb61ff1301a2a614ad8b0c517b919b92d7c56) |
| `open` | [`0x06213cd59cc3e904…`](https://explorer.testnet.arc.io/tx/0x06213cd59cc3e90449062477b75a57ff4c541e6ba52e03bf9dd0585e46697edc) |
| `deliver` | [`0x4999df53d9489507…`](https://explorer.testnet.arc.io/tx/0x4999df53d94895073c34550a4f1100697f66e0460c4e074dc65914911fa72b42) |
| `settle` | [`0xe5a0baee3367ab1f…`](https://explorer.testnet.arc.io/tx/0xe5a0baee3367ab1f6cd23d98e78bf5405507da3c3103e4c4e06d52a562eba808) |

## buggy code: failed (0/3 tests passed)

Case `0xa60b623db86887af0779b1143abcff98f3b7779a2227b6c3db2f859a4d0d740b`. The contract refunded the buyer $0.0500; the buyer submitted the ruling and paid $0.0020 gas (on Arc, gas is paid in USDC).
Ruling hash `0x66df780c1e85bbab08762248fedc4a366ae6bdecd2d9d89ae5ba7d68fa7e526a`, saved as [ruling-0x66df780c1e85bbab08762248fedc4a366ae6bdecd2d9d89ae5ba7d68fa7e526a.json](ruling-0x66df780c1e85bbab08762248fedc4a366ae6bdecd2d9d89ae5ba7d68fa7e526a.json).

| step | transaction |
|---|---|
| `approve` | [`0x439e0bbc7a4fa4c1…`](https://explorer.testnet.arc.io/tx/0x439e0bbc7a4fa4c135d097fe5e5f127ba9ffbdeef987fc1c88f40537179e8585) |
| `open` | [`0xf208873c6ed3dfc8…`](https://explorer.testnet.arc.io/tx/0xf208873c6ed3dfc8a2475f9ceea268a75c29472a3b900e32134a471005160517) |
| `deliver` | [`0x018eb877fc28903f…`](https://explorer.testnet.arc.io/tx/0x018eb877fc28903fcb080786e5287077905975133dccf50d47d1f85a62b59ee3) |
| `settle` | [`0x3f2502704f5d8b1e…`](https://explorer.testnet.arc.io/tx/0x3f2502704f5d8b1e0035ac4d66e8f53f920fa9f24c987fcf80b39222bb1ba168) |
