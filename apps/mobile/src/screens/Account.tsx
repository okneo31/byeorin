import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import type { WalletAccount } from '@nodong/wallet-sdk';
import { useT } from '@nodong/i18n/react';
import { walletStore } from '../store';
import { colors, radius, spacing, theme } from '../theme';
import { AddressDisplay, AmountDisplay, Button, Card } from '../ui';

interface Props {
  onSend: () => void;
  onLock: () => void;
}

const TTL_DECIMALS = 18;

export function Account({ onSend, onLock }: Props) {
  const t = useT();
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!walletStore.isUnlocked()) {
      setAccount(null);
      return;
    }
    void walletStore.getAccount().then((a) => {
      if (!cancelled) setAccount(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    setError(null);
    try {
      const bal = await walletStore.getDefaultAdapter().getBalance(account.address);
      setBalance(bal);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('account.balance_failed'));
    } finally {
      setLoading(false);
    }
  }, [account, t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!account) {
    return (
      <View style={styles.empty}>
        <Text style={styles.lead}>{t('account.locked_msg')}</Text>
        <Button variant="primary" onPress={onLock}>
          {t('account.to_home')}
        </Button>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.h1}>{t('account.title_mobile')}</Text>
      <Text style={styles.lead}>{t('account.subtitle_ttl')}</Text>

      <Card style={styles.section}>
        <Text style={styles.label}>{t('account.address_label')}</Text>
        <AddressDisplay address={account.address} head={6} tail={4} />
        <View style={styles.qrWrap}>
          <View style={styles.qrBg}>
            {/* QR background must be pure white for scanner contrast; DS's warm
                `paper` (#fffaf0) hurts machine-read reliability. */}
            <QRCode value={account.address} size={180} backgroundColor="#ffffff" />
          </View>
        </View>
      </Card>

      <Card style={styles.section}>
        <Text style={styles.label}>{t('account.balance_label')}</Text>
        {loading ? (
          <ActivityIndicator color={colors.primary} />
        ) : balance != null ? (
          <AmountDisplay value={balance} decimals={TTL_DECIMALS} symbol="TTL" size="lg" />
        ) : (
          <Text style={styles.balanceEmpty}>—</Text>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
        <View style={{ height: spacing.sm }} />
        <Button variant="ghost" fullWidth onPress={refresh} disabled={loading}>
          {t('common.refresh')}
        </Button>
      </Card>

      <Button variant="primary" fullWidth onPress={onSend}>
        {t('account.send')}
      </Button>
      <View style={styles.btnSpacer} />
      <Button variant="ghost" fullWidth onPress={onLock}>
        {t('common.lock')}
      </Button>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingBottom: spacing.xl,
  },
  empty: {
    paddingVertical: spacing.xl,
    alignItems: 'center',
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
  label: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontFamily: theme.font.korean,
  },
  section: {
    marginBottom: spacing.md,
  },
  qrWrap: {
    alignItems: 'center',
    paddingTop: spacing.md,
  },
  qrBg: {
    padding: spacing.md,
    // Pure white border around the QR matches the QR backgroundColor above
    // (scanner contrast — see comment in JSX).
    backgroundColor: '#ffffff',
    borderRadius: radius.md,
  },
  balanceEmpty: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
    fontFamily: theme.font.mono,
  },
  btnSpacer: {
    height: spacing.sm,
  },
  error: {
    color: colors.error,
    fontSize: 13,
    marginTop: spacing.sm,
    fontFamily: theme.font.korean,
  },
});
