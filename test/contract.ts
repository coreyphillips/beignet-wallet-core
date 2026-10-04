import {
  DemoWalletClient,
  EmbeddedWalletClient,
  WalletClient,
  type WalletClientInterface,
  type Activity,
  type Connection,
  type SendResult,
  type ReceiveStatus,
  type WalletRecoveryStatus,
} from "../src/index.js";
const connection: Connection = {
  url: "http://127.0.0.1:8787",
  token: "local-test-token",
  walletId: "wallet-1",
};
const clients: WalletClientInterface[] = [
  new DemoWalletClient(),
  new WalletClient(connection),
];
async function verifyContract(
  client: WalletClientInterface,
): Promise<SendResult> {
  const snapshot = await client.snapshot();
  const recovery: WalletRecoveryStatus = await client.getRecoveryStatus();
  void recovery;
  const primarySetupError: string | undefined = snapshot.primary.setupError;
  const walletSetupError: string | undefined = snapshot.wallet.lfbw?.setupError;
  void primarySetupError;
  void walletSetupError;
  const activity: Activity[] = snapshot.activity;
  const quote = await client.quoteReceive({
    amountSats: 1000,
    description: activity[0]?.description,
    mode: "unified",
  });
  const receive = await client.receive(quote);
  const receiveStatus: ReceiveStatus = await client.getReceiveStatus(receive);
  const restored = await client.importReceiveRequest(
    receive.uri,
    receive.paymentHash,
  );
  void restored;
  void receiveStatus;
  const review = await client.prepareSend({ request: receive.uri });
  const drainReview = await client.prepareDrain({ address: receive.address! });
  const drainProgress = await client.getDrain(drainReview.id);
  const cancelledDrain = await client.cancelDrain(drainReview.id);
  void drainProgress;
  void cancelledDrain;
  const maximum = await client.quoteMax({ request: receive.uri });
  const kept: number = maximum.keptSats;
  const maxReview = await client.prepareSend({ request: receive.uri, max: true });
  const exactBudget: string | undefined = maxReview.debitMsat;
  void kept;
  void exactBudget;
  return client.send(review);
}
const localClient: WalletClientInterface = new EmbeddedWalletClient({
  runtime: { request: async () => ({}) },
});
void localClient;
void clients;
void verifyContract;
