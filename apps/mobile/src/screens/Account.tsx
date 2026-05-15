import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { getAccount, getAdapter } from '../store';
import { colors, radius, spacing } from '../theme';
import { formatTtl } from '../units';

interface Props {
  onSend: () => void;
  onLock: () => void;
}

export function Account({ onSend, onLock }: Props) {
  const account = getAccount();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    setError(null);
    try {
      const bal = await getAdapter().getBalance(account.address);
      setBalance(bal);
    } catch (e) {
      setError(e instanceof Error ? e.message : '잔액 조회 실패');
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!account) {
    return (
      <View style={styles.empty}>
        <Text style={styles.lead}>지갑이 잠겨 있습니다.</Text>
        <Pressable style={[styles.btn, styles.btnPrimary]} onPress={onLock}>
          <Text style={styles.btnPrimaryText}>처음으로</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.h1}>내 계정</Text>
      <Text style={styles.lead}>TTL 메인넷 · ChainId 7777</Text>

      <View style={styles.card}>
        <Text style={styles.label}>주소</Text>
        <Text style={styles.address} selectable>
          {account.address}
        </Text>
        <View style={styles.qrWrap}>
          <View style={styles.qrBg}>
            <QRCode value={account.address} size={180} backgroundColor="#ffffff" />
          </View>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>잔액</Text>
        {loading ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <Text style={styles.balance}>
            {balance != null ? `${formatTtl(balance)} TTL` : '—'}
          </Text>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
        <View style={{ height: spacing.sm }} />
        <Pressable
          style={({ pressed }) => [styles.btn, styles.btnGhost, pressed && styles.btnGhostPressed]}
          onPress={refresh}
          disabled={loading}
        >
          <Text style={styles.btnGhostText}>새로고침</Text>
        </Pressable>
      </View>

      <Pressable
        style={({ pressed }) => [
          styles.btn,
          styles.btnPrimary,
          pressed && styles.btnPrimaryPressed,
        ]}
        onPress={onSend}
      >
        <Text style={styles.btnPrimaryText}>보내기</Text>
      </Pressable>
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
  address: {
    color: colors.text,
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 20,
    marginBottom: spacing.md,
  },
  qrWrap: {
    alignItems: 'center',
    paddingTop: spacing.sm,
  },
  qrBg: {
    padding: spacing.md,
    backgroundColor: '#ffffff',
    borderRadius: radius.md,
  },
  balance: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
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
  error: {
    color: colors.error,
    fontSize: 13,
    marginTop: spacing.sm,
  },
});
