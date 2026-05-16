import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  WalletConnectSigner,
  signEvmMessage,
  type WcDelegate,
  type WcSession,
  type WcSessionProposal,
} from '@nodong/wallet-sdk';
import { useT } from '@nodong/i18n/react';
import { walletStore } from '../store';
import { colors, radius, spacing, theme } from '../theme';
import { Button, Card, Input } from '../ui';

/**
 * 모바일 dApp 연결 화면 (WalletConnect v2 / Reown WalletKit).
 *
 * v0.3 스코프:
 *   - 사용자가 wc: URI 를 붙여넣어 페어링 (TextInput fallback)
 *   - "QR로 페어링" 버튼은 placeholder — 네이티브 QR scanner 도입 시 활성
 *   - 활성 세션 목록 표시 / 연결 해제
 *
 * Native TODO (deep link / QR):
 *   `nodong://wc?uri=<wc-uri>` 형태의 deep link 를 받아 자동 페어링하려면
 *   - Android: `AndroidManifest.xml` 에 intent-filter 추가
 *       <data android:scheme="nodong" android:host="wc" />
 *   - iOS: `Info.plist` 의 `CFBundleURLTypes` 에 `nodong` scheme 등록
 *   - JS 측: react-native `Linking.getInitialURL` + `addEventListener('url')`
 *   현재 본 repo 는 `android/` / `ios/` 폴더가 없어 네이티브 설정을 적용할 수
 *   없다. JS 레이어만 ship 하고 네이티브는 별도 PR 로 다룬다.
 *
 *   QR scan 도 비슷한 이유로 placeholder. react-native-vision-camera 또는
 *   react-native-qrcode-scanner 의존성 + 네이티브 권한 설정이 필요하다.
 */

interface Props {
  onBack: () => void;
}

const PROJECT_ID =
  (process.env.WC_PROJECT_ID as string | undefined) ?? '__nodong_dev_placeholder__';

type ProposalView = {
  proposal: WcSessionProposal;
  decide: (approve: boolean) => void;
};

export function DApp({ onBack }: Props) {
  const t = useT();
  const [signer, setSigner] = useState<WalletConnectSigner | null>(null);
  const [signerError, setSignerError] = useState<string | null>(null);
  const [uri, setUri] = useState('');
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<WcSession[]>([]);
  const [proposal, setProposal] = useState<ProposalView | null>(null);
  const initRef = useRef(false);

  const refreshSessions = useCallback(async (s: WalletConnectSigner) => {
    try {
      const list = await s.activeSessions();
      setSessions(list);
    } catch {
      /* best-effort */
    }
  }, []);

  useEffect(() => {
    if (initRef.current) return;
    if (!walletStore.isUnlocked()) return;
    initRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const s = await WalletConnectSigner.create({
          projectId: PROJECT_ID,
          metadata: {
            // Brand name stays Korean in both locales (see brand identity policy).
            name: t('dapp.wc_name_mobile'),
            description: t('dapp.wc_description'),
            url: 'https://ttl1.top',
            icons: ['https://ttl1.top/icon.png'],
          },
          chainId: 7777,
        });
        if (cancelled) return;
        bindDelegate(s, t);
        s.onSessionProposal((p) => {
          return new Promise((resolve) => {
            setProposal({
              proposal: p,
              decide: async (approve) => {
                setProposal(null);
                if (!approve) {
                  resolve({ approved: [] });
                  return;
                }
                const acc = await walletStore.getAccount();
                resolve({ approved: [`eip155:7777:${acc.address}`] });
                setTimeout(() => void refreshSessions(s), 500);
              },
            });
          });
        });
        setSigner(s);
        void refreshSessions(s);
      } catch (err) {
        if (cancelled) return;
        setSignerError(err instanceof Error ? err.message : String(err));
        initRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshSessions]);

  const onPair = async () => {
    setPairError(null);
    if (!signer) {
      setPairError(t('dapp.signer_not_ready_short'));
      return;
    }
    const trimmed = uri.trim();
    if (!trimmed.startsWith('wc:')) {
      setPairError(t('dapp.uri_invalid_short'));
      return;
    }
    setPairing(true);
    try {
      await signer.pair(trimmed);
      setUri('');
      setTimeout(() => void refreshSessions(signer), 1500);
    } catch (e) {
      setPairError(e instanceof Error ? e.message : String(e));
    } finally {
      setPairing(false);
    }
  };

  const onDisconnect = async (topic: string) => {
    if (!signer) return;
    try {
      await signer.disconnect(topic);
    } catch {
      /* dApp may already have disconnected */
    }
    await refreshSessions(signer);
  };

  // QR 페어링은 네이티브 카메라 권한이 필요해 v0.3 에서는 placeholder.
  const onQrPlaceholder = () => {
    setPairError(t('dapp.qr_placeholder_msg'));
  };

  if (!walletStore.isUnlocked()) {
    return (
      <View style={styles.center}>
        <Text style={styles.lead}>{t('account.locked_msg')}</Text>
        <Button variant="primary" onPress={onBack}>
          {t('dapp.back')}
        </Button>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.h1}>{t('dapp.title')}</Text>
      <Text style={styles.lead}>{t('dapp.lead_mobile')}</Text>

      {PROJECT_ID === '__nodong_dev_placeholder__' && (
        <View style={styles.warn}>
          <Text style={styles.warnText}>
            {t('dapp.projectid_missing_mobile')}
          </Text>
        </View>
      )}

      {signerError && (
        <View style={styles.error}>
          <Text style={styles.errorText}>{t('dapp.init_failed', { detail: signerError })}</Text>
        </View>
      )}

      <Card style={styles.section}>
        <Text style={styles.label}>{t('dapp.uri_label')}</Text>
        <Input
          value={uri}
          onChangeText={setUri}
          placeholder="wc:..."
          autoCapitalize="none"
          autoCorrect={false}
          mono
        />
        {pairError && (
          <View style={styles.error}>
            <Text style={styles.errorText}>{pairError}</Text>
          </View>
        )}
        <View style={{ height: spacing.sm }} />
        <Button variant="primary" fullWidth onPress={onPair} disabled={pairing || !signer}>
          {pairing ? t('dapp.pairing') : t('dapp.pair_button')}
        </Button>
        <View style={{ height: spacing.sm }} />
        <Button variant="ghost" fullWidth onPress={onQrPlaceholder}>
          {t('dapp.qr_pair_coming_soon')}
        </Button>
      </Card>

      {proposal && (
        <Card style={styles.section}>
          <Text style={styles.label}>{t('dapp.proposal_label')}</Text>
          <Text style={styles.body}>
            <Text style={styles.bold}>{proposal.proposal.proposer.metadata.name}</Text>
            {t('dapp.proposal_text_suffix')}
          </Text>
          <Text style={styles.muted}>{proposal.proposal.proposer.metadata.url}</Text>
          <View style={{ height: spacing.sm }} />
          <Button variant="primary" fullWidth onPress={() => proposal.decide(true)}>
            {t('confirm.btn.approve')}
          </Button>
          <View style={{ height: spacing.xs }} />
          <Button variant="ghost" fullWidth onPress={() => proposal.decide(false)}>
            {t('confirm.btn.reject')}
          </Button>
        </Card>
      )}

      <Card style={styles.section}>
        <Text style={styles.label}>{t('dapp.sessions_label')}</Text>
        {sessions.length === 0 ? (
          <Text style={styles.muted}>{t('dapp.no_active_sessions')}</Text>
        ) : (
          sessions.map((s) => (
            <View key={s.topic} style={styles.sessionRow}>
              <View style={styles.sessionMain}>
                <Text style={styles.sessionTitle}>{s.peer.name}</Text>
                <Text style={styles.muted} numberOfLines={1}>
                  {s.peer.url}
                </Text>
                <Text style={styles.topic} numberOfLines={1}>
                  topic: {s.topic.slice(0, 12)}…
                </Text>
              </View>
              <Button variant="ghost" onPress={() => onDisconnect(s.topic)}>
                {t('popup.connected_sites.revoke')}
              </Button>
            </View>
          ))
        )}
      </Card>

      <View style={{ height: spacing.md }} />
      <Button variant="ghost" fullWidth onPress={onBack}>
        {t('dapp.back')}
      </Button>
    </ScrollView>
  );
}

/**
 * Wire the SDK delegate to the mobile walletStore. Mirrors the desktop flow —
 * personalSign goes through `signEvmMessage`, sendTransaction through
 * `walletStore.transfer`. Typed-data signing on mobile is intentionally
 * minimal: the mobile shell does not import viem to keep the JS bundle small;
 * if a dApp requests EIP-712 signing the delegate throws a clear error and
 * the shell upgrades in a follow-up patch.
 */
function bindDelegate(
  signer: WalletConnectSigner,
  t: (key: string, vars?: Record<string, string | number>) => string,
): void {
  const delegate: WcDelegate = {
    getActiveEvmAddress: async () => {
      const acc = await walletStore.getAccount();
      return acc.address;
    },
    personalSign: async (message, _address) => {
      const acc = await walletStore.getAccount();
      // hexToBytes is not exported by the SDK — inline a tiny helper. This
      // keeps the mobile bundle free of viem.
      const bytes = hexToBytes(message);
      return signEvmMessage(acc.signer, acc.address, bytes);
    },
    signTypedData: async () => {
      // v0.3: surface a clear error on mobile rather than silently failing.
      // Desktop has the full viem path; mobile gets it once we settle the
      // bundle-size budget.
      throw new Error(t('dapp.typed_data_v05_note'));
    },
    sendTransaction: async (tx) => {
      const valueWei = tx.value ? BigInt(tx.value) : 0n;
      const intent =
        tx.data && tx.data !== '0x'
          ? { to: tx.to, amount: valueWei, data: tx.data as `0x${string}` }
          : { to: tx.to, amount: valueWei };
      return walletStore.transfer(intent);
    },
    publicClient: () => {
      const a = walletStore.getDefaultAdapter() as unknown as { client?: unknown };
      return (a.client as ReturnType<WcDelegate['publicClient']>) ?? null;
    },
    chainId: () => 7777,
  };
  signer.bindDelegate(delegate);
}

/** Tiny 0x… hex → bytes. Mirrors viem.hexToBytes for our use case (the WC
 *  adapter always hands us validated 0x-prefixed hex). Kept inline to avoid
 *  pulling viem into the mobile bundle. */
function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error('hexToBytes: odd-length hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const styles = StyleSheet.create({
  container: {
    paddingBottom: spacing.xl,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  h1: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '800',
    marginBottom: spacing.xs,
    fontFamily: theme.font.korean,
  },
  lead: {
    color: colors.textMuted,
    fontSize: 13,
    marginBottom: spacing.lg,
    fontFamily: theme.font.korean,
  },
  section: {
    marginBottom: spacing.md,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontFamily: theme.font.korean,
  },
  body: {
    color: colors.text,
    fontSize: 14,
    fontFamily: theme.font.korean,
    lineHeight: 20,
  },
  bold: {
    fontWeight: '700',
  },
  muted: {
    color: colors.textMuted,
    fontSize: 12,
    fontFamily: theme.font.korean,
  },
  topic: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: theme.font.mono,
    marginTop: 2,
  },
  warn: {
    backgroundColor: '#3a2e0a',
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  warnText: {
    color: colors.warn,
    fontSize: 12,
    fontFamily: theme.font.korean,
  },
  error: {
    backgroundColor: '#3a0e0e',
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: spacing.sm,
  },
  errorText: {
    color: colors.error,
    fontSize: 12,
    fontFamily: theme.font.korean,
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sessionMain: {
    flex: 1,
    minWidth: 0,
  },
  sessionTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    fontFamily: theme.font.korean,
  },
});
