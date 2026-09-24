# Persistent regtest node for the phase 2 end-to-end test. Isolated in /tmp.
# Run from Windows: wsl -e bash packages/core/scripts/regtest-node.sh  (keep it running)
# Mines 101 blocks (~25 min) to index 0 of the 0x42 test seed, then
# `pnpm --filter @pearl-wallet/core test:live` runs test/live/regtest.live.ts.
B=~/code/pearl/bin
D=/tmp/pw-regtest
rm -rf $D; mkdir -p $D
$B/pearld --regtest -b $D -C /dev/null --logdir=$D/logs --nolisten --nodnsseed --notls \
  --rpclisten=0.0.0.0:44990 -u v -P v --miningaddr=rprl1pfj2vd8zrgmrt2tu75t7kx29ju673v3mc8peqnp676524aayl0tvqux3qct > $D/out 2>&1 &
N=$!
sleep 4
C="$B/prlctl -C /dev/null --regtest --notls -s 127.0.0.1:44990 -u v -P v"
for i in $(seq 1 101); do $C generate 1 >/dev/null 2>&1 || echo "gen fail $i"; done
echo "READY height $($C getblockcount)"
wait $N
