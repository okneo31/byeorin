import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Wallet } from '@nodong/wallet-sdk';
import { getAccount, getWallet } from '../store';
import { colors, radius, spacing } from '../theme';
import { parseTtl } from '../units';

interface Props {
  onBack: () => void;
}

export function Send({ onBack }: Props) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);
    setTxHash(null);
    const account = getAccount();
    const wallet = getWallet();
    if (!account || !wallet) {
      setError('지갑이 잠겨 있습니다.');
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(to.trim())) {
      setError('받는 주소 형식이 올바르지 않습니다.');
      return;
    }
    let value: bigint;
    try {
      value = parseTtl(amount);
    } catch {
      setError('금액 형식이 올바르지 않습니다.');
      return;
    }
    if (value <= 0n) {
      setError('0보다 큰 금액을 입력하세요.');
      return;
    }

    setBusy(true);
    try {
      const hash = await (wallet as Wallet).transfer(account, {
        to: to.trim(),
        amount: value,
      });
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

      <View style={styles.card}>
        <Text style={styles.label}>받는 주소</Text>
        <TextInput
          style={styles.input}
          value={to}
          onChangeText={setTo}
          placeholder="0x..."
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>금액 (TTL)</Text>
        <TextInput
          style={styles.input}
          value={amount}
          onChangeText={setAmount}
          placeholder="0.0"
          placeholderTextColor={colors.textMuted}
          keyboardType="decimal-pad"
        />
      </View>

      {error && <Text style={styles.error}>{error}</Text>}
      {txHash && (
        <View style={styles.successCard}>
          <Text style={styles.successLabel}>전송 완료</Text>
          <Text style={styles.txHash} selectable>
            {txHash}
          </Text>
        </View>
      )}

      <Pressable
        style={({ pressed }) => [
          styles.btn,
          styles.btnPrimary,
          pressed && styles.btnPrimaryPressed,
          busy && styles.btnDisabled,
        ]}
        onPress={onSubmit}
        disabled={busy}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.btnPrimaryText}>전송</Text>
        )}
      </Pressable>

      <Pressable
        style={({ pressed }) => [styles.btn, styles.btnGhost, pressed && styles.btnGhostPressed]}
        onPress={onBack}
      >
        <Text style={styles.btnGhostText}>뒤로</Text>
      </Pressable>
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
  },
  lead: {
    color: colors.textMuted,
    fontSize: 13,
    marginBottom: spacing.lg,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  input: {
    color: colors.text,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: 15,
  },
  successCard: {
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
  },
  txHash: {
    color: colors.text,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  btn: {
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  btnPrimary: {
    backgroundColor: colors.primary,
  },
  btnPrimaryPressed: {
    backgroundColor: colors.primaryPressed,
  },
  btnPrimaryText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  btnGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  btnGhostPressed: {
    backgroundColor: colors.surfaceAlt,
  },
  btnGhostText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  btnDisabled: {
    opacity: 0.5,
  },
  error: {
    color: colors.error,
    fontSize: 13,
    marginBottom: spacing.sm,
  },
});
