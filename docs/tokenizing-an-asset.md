# Tokenizing an asset

The `/asset/new` wizard registers an already-deployed asset-token contract with
the Stellar RWA registry. It does not deploy contracts: deploying and
initializing the asset-token and compliance contracts must happen first, using
the [stellar-rwa-contracts repository](https://github.com/RWA-ToolKit/stellar-rwa-contracts)
and the issuer's Stellar account.

## Before opening the wizard

1. Deploy and initialize the asset-token contract and its compliance contract
   on the network selected in the app.
2. Keep the asset-token contract ID and connect the issuer wallet. The connected
   address is recorded as the registry issuer and must be authorized to register
   the asset.
3. Confirm the token's metadata is initialized, including a name and symbol.
   The wizard reads this metadata from the deployed contract.

## Wizard flow

1. **Token contract:** Enter the deployed contract ID. The wizard checks that it
   is a valid Soroban contract address and calls `get_metadata` on the selected
   network. It only proceeds if the contract responds with a name and symbol.
2. **Asset details:** Set the registry display name, asset class (real estate,
   invoice, commodity, bond, equity, or fund), and valuation in USD. The name
   and class are pre-filled from token metadata where possible, but the registry
   name can be changed. The valuation must be greater than zero.
3. **Review and register:** Check the registry values, token contract, issuer,
   and compliance contract. Confirming submits `register_asset` to the registry.
   The app simulates and prepares the transaction, asks Freighter to sign it,
   submits it, and waits for confirmation.
4. **Done:** The confirmation view shows the registry asset ID when returned,
   the transaction hash, and links to the new asset page and issuer dashboard.

The registry stores the display name, asset class, valuation, token contract,
and issuer address. Token balances and transfer restrictions remain controlled
by the deployed contracts; transfers are checked against the compliance
contract on-chain.

## Supported asset classes

The wizard, the Explore filter chips (with their counts) and the `?type=` URL
parameter all read their options from `ASSET_TYPES` in `types/index.ts`. That
list must mirror `VALID_ASSET_TYPES` in the registry contract
(`stellar-rwa-contracts`, `contracts/registry`), which rejects any other value.
When the contract's list changes, update `ASSET_TYPES`, `ASSET_TYPE_LABELS` and
the badge styles in `components/asset/AssetTypeBadge.tsx` together;
`types/__tests__/assetTypes.test.tsx` fails if they drift apart.

## Where the flow is implemented

- `app/asset/new/page.tsx` renders the route and page metadata.
- `components/tokenize/TokenizeWizard.tsx` holds wizard state and moves between
  the four steps.
- `components/tokenize/Step1TokenContract.tsx` validates the address and calls
  `validateTokenContract`.
- `components/tokenize/Step2AssetDetails.tsx` collects and validates registry
  fields.
- `components/tokenize/Step3Confirm.tsx` submits `registry.registerAsset` via
  `useTx`.
- `components/tokenize/Step4Done.tsx` presents the confirmed registration.
- `lib/tokenizeFlow.ts` contains the shared token-contract validation logic.
