/**
 * 标准真实 Linux 系统 VMON/1 原始采集输出 fixture
 * 采样自 Linux 7.0 / Debian 12 兼容环境
 */

export const REAL_LINUX_VMON1_OUTPUT = `VMON/1
@@uptime_begin
108340.61 1599295.52
@@boot_id
0bc0262c-85e6-41dd-b1f0-906cba537e57
@@stat
cpu  7563746 11573 4008968 159929570 49056 0 59368 0 0 0
cpu0 522033 804 256623 9834506 3526 0 39277 0 0 0
cpu1 439293 355 197130 10081826 2888 0 1022 0 0 0
cpu2 499357 829 254738 9967759 3261 0 2378 0 0 0
cpu3 455129 425 200193 10096997 3156 0 236 0 0 0
cpu4 496508 806 253847 9978571 3409 0 504 0 0 0
cpu5 463176 384 201678 10091473 2851 0 130 0 0 0
cpu6 484017 703 251246 9994482 3209 0 269 0 0 0
cpu7 458373 379 201905 10096369 2741 0 108 0 0 0
cpu8 531997 1504 305315 9871693 3302 0 598 0 0 0
cpu9 437172 398 242495 10065888 2949 0 340 0 0 0
cpu10 512378 1238 303167 9897301 3129 0 475 0 0 0
cpu11 444080 508 246823 10054525 3134 0 239 0 0 0
cpu12 508015 782 309166 9870863 3225 0 11117 0 0 0
cpu13 376548 342 241490 10057575 2247 0 347 0 0 0
cpu14 496168 993 307024 9907106 3166 0 583 0 0 0
cpu15 439495 1115 236121 10062628 2856 0 1739 0 0 0
intr 793610842 142 72 0 0
ctxt 989335241
btime 1791336537
processes 246063
procs_running 1
procs_blocked 0
softirq 315878783 1209838 25139458 3067 17951752 1561 0 401181 160189519 13581 110968826
@@loadavg
3.26 2.22 1.90 2/2727 246050
@@meminfo
MemTotal:       15242972 kB
MemFree:         1538848 kB
MemAvailable:    2492756 kB
Buffers:           12256 kB
Cached:          1176760 kB
SwapCached:        58272 kB
Active:          3028444 kB
Inactive:        2686288 kB
SwapTotal:       4194300 kB
SwapFree:            152 kB
Shmem:            213056 kB
SReclaimable:     314372 kB
SUnreclaim:       351264 kB
@@netdev
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 25079149582 4249655    0    0    0     0          0         0 25079149582 4249655    0    0    0     0       0          0
enp2s0: 5278916018 5707674    0   14    0     0          0      1852 2720256536 3987389    0    0    0     0       0          0
wlp3s0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0
  Meta: 2422295488 1764025    0    0    0     0          0         0 2250181555 1466457    0    0    0     0       0          0
@@ifindex
Meta 4
enp2s0 2
lo 1
wlp3s0 3
@@df
Filesystem     1024-blocks       Used Available Capacity Mounted on
tmpfs              3048596       2316   3046280       1% /run
/dev/nvme0n1p5   205307624   49373924 145431560      26% /
tmpfs              7621484     300684   7320800       4% /dev/shm
/dev/nvme0n1p3   765925764  310330776 455594988      41% /mnt/windows-c
/dev/nvme1n1p5  1953512444 1603156504 350355940      83% /mnt/data with spaces
@@uptime_end
108340.68 1599296.35
@@end
`;

/**
 * 带有大整数溢出（超 2^53）及 BusyBox df 风格的 fixture
 */
export const BUSYBOX_AND_HUGE_COUNTER_FIXTURE = `VMON/1
@@uptime_begin
500.12 990.22
@@boot_id
11111111-2222-3333-4444-555555555555
@@stat
cpu  1000 200 300 4000 50 10 20 5 0 0
cpu0 1000 200 300 4000 50 10 20 5 0 0
@@loadavg
0.50 0.75 0.80 1/120 1234
@@meminfo
MemTotal:        1048576 kB
MemFree:          200000 kB
Buffers:           50000 kB
Cached:           300000 kB
SReclaimable:      50000 kB
Shmem:             10000 kB
SwapTotal:             0 kB
SwapFree:              0 kB
@@netdev
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  eth0: 18446744073709551615 10000 0 0 0 0 0 0 9223372036854775807 5000 0 0 0 0 0 0
@@ifindex
eth0 10
@@df
Filesystem           1k-blocks      Used Available Use% Mounted on
/dev/vda1             41943040   8388608  33554432  20% /
@@uptime_end
500.18 990.28
@@end
`;
