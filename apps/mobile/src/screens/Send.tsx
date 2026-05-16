import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { ShellError } from '@nodong/shell-core';
import { useT } from '@nodong/i18n/react';
import { walletStore } from '../store';
import { colors, radius, spacing, theme } from '../theme';
import { parseTtl } from '../units';
import { Button, Card, Input } from '../ui';

interface Props {
  onBack: () => void;
}

export function Send({ onBack }: Props) {
  const t = useT();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toError, setToError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);
    setToError(null);
    setAmountError(null);
    setTxHash(null);
    if (!walletStore.isUnlocked()) {
      setError(t('send.locked_warn'));
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(to.trim())) {
      setToError(t('send.to_invalid_mobile'));
      return;
    }
    let value: bigint;
    try {
      value = parseTtl(amount);
    } catch {
      setAmountError(t('send.amount_invalid'));
      return;
    }
    if (value <= 0n) {
      setAmountError(t('send.amount_must_be_positive'));
      return;
    }

    setBusy(true);
    try {
      const hash = await walletStore.transfer({ to: to.trim(), amount: value });
      setTxHash(hash);
    } catch (e) {
      if (e instanceof ShellError) {
        setError(t(`errors.${e.code}`));
      } else if (e instanceof Error) {
        setError(e.message || t('send.failed_short'));
      } else {
        setError(t('send.failed_short'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.h1}>{t('send.title_mobile')}</Text>
      <Text style={styles.lead}>{t('send.lead_native_mobile')}</Text>

      <Card style={styles.section}>
        <Input
          label={t('send.to_label')}
          value={to}
          onChangeText={setTo}
          placeholder="0x..."
          autoCapitalize="none"
          autoCorrect={false}
          mono
          error={toError ?? undefined}
        />
      </Card>

      <Card style={styles.section}>
        <Input
          label={t('send.amount_label', { symbol: 'TTL' })}
          value={amount}
          onChangeText={setAmount}
          placeholder="0.0"
          keyboardType="decimal-pad"
          autoCapitalize="none"
          autoCorrect={false}
          mono
          error={amountError ?? undefined}
        />
      </Card>

      {error && <Text style={styles.error}>{error}</Text>}
      {txHash && (
        <View style={styles.successCard}>
          <Text style={styles.successLabel}>{t('send.completed')}</Text>
          <Text style={styles.txHash} selectable>
            {txHash}
          </Text>
        </View>
      )}

      <Button variant="primary" fullWidth loading={busy} onPress={onSubmit}>
        {t('send.submit_mobile')}
      </Button>
      <View style={styles.btnSpacer} />
      <Button variant="ghost" fullWidth onPress={onBack}>
        {t('common.back')}
      </Button>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingBottom: spacing.xl,
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
  btnSpacer: {
    height: spacing.sm,
  },
  successCard: {
    // TODO(design-system): no dark-tinted success surface in DS — local value.
    backgroundColor: '#0d2614',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.success,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  successLabel: {
    color: colors.success,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: spacing.xs,
    fontFamily: theme.font.korean,
  },
  txHash: {
    color: colors.text,
    fontSize: 12,
    fontFamily: theme.font.mono,
  },
  error: {
    color: colors.error,
    fontSize: 13,
    marginBottom: spacing.sm,
    fontFamily: theme.font.korean,
  },
});
