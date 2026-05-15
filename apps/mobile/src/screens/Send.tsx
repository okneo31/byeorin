import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { walletStore } from '../store';
import { colors, radius, spacing, theme } from '../theme';
import { parseTtl } from '../units';
import { Button, Card, Input } from '../ui';

interface Props {
  onBack: () => void;
}

export function Send({ onBack }: Props) {
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
      setError('지갑이 잠겨 있습니다.');
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(to.trim())) {
      setToError('받는 주소 형식이 올바르지 않습니다.');
      return;
    }
    let value: bigint;
    try {
      value = parseTtl(amount);
    } catch {
      setAmountError('금액 형식이 올바르지 않습니다.');
      return;
    }
    if (value <= 0n) {
      setAmountError('0보다 큰 금액을 입력하세요.');
      return;
    }

    setBusy(true);
    try {
      const hash = await walletStore.transfer({ to: to.trim(), amount: value });
      setTxHash(hash);
    } catch (e) {
      setError(e instanceof Error ? e.message : '전송 실패');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.h1}>보내기</Text>
      <Text style={styles.lead}>TTL 메인넷에서 네이티브 자산을 전송합니다.</Text>

      <Card style={styles.section}>
        <Input
          label="받는 주소"
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
          label="금액 (TTL)"
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
          <Text style={styles.successLabel}>전송 완료</Text>
          <Text style={styles.txHash} selectable>
            {txHash}
          </Text>
        </View>
      )}

      <Button variant="primary" fullWidth loading={busy} onPress={onSubmit}>
        전송
      </Button>
      <View style={styles.btnSpacer} />
      <Button variant="ghost" fullWidth onPress={onBack}>
        뒤로
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
