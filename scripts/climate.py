"""Group IMERG squares into rain calendars with k-means.

Each square is described by 12 numbers: the share of its average 2001-2025 year
that falls in each calendar month, stored as integers per ten thousand. k-means
clusters those shapes, not rainfall totals. Initialisation is deterministic
(maximin from the square with the largest January to April share), and the
arithmetic order matches ``src/lib/kmeans.ts`` exactly, so the browser's
step-by-step demo reproduces this result.
"""

SCALE = 10000
K = 4
MAX_ITERATIONS = 300


def month_shares(cube):
    """Per-square average-year monthly shares, integers per ten thousand, keyed by (row, col)."""
    shares = {}
    for pixel in cube["pixels"]:
        monthly = pixel["monthly_mm"]
        years = len(monthly) // 12
        clim = [sum(monthly[k * 12 + m] for k in range(years)) / years for m in range(12)]
        total = sum(clim)
        if total <= 0:
            raise ValueError(f"Square {pixel['id']} has no rain to share across months")
        shares[(pixel["row"], pixel["col"])] = [round(SCALE * v / total) for v in clim]
    return shares


def distance(x, c):
    d = 0.0
    for m in range(12):
        diff = x[m] - c[m]
        d += diff * diff
    return d


def maximin(points, k):
    first = 0
    for i in range(1, len(points)):
        if sum(points[i][:4]) > sum(points[first][:4]):
            first = i
    centroids = [list(points[first])]
    nearest = [distance(p, centroids[0]) for p in points]
    while len(centroids) < k:
        far = 0
        for i in range(1, len(points)):
            if nearest[i] > nearest[far]:
                far = i
        centroids.append(list(points[far]))
        nearest = [min(nearest[i], distance(p, centroids[-1])) for i, p in enumerate(points)]
    return centroids


def assign(points, centroids):
    labels = []
    for p in points:
        best, best_d = 0, distance(p, centroids[0])
        for j in range(1, len(centroids)):
            d = distance(p, centroids[j])
            if d < best_d:
                best, best_d = j, d
        labels.append(best)
    return labels


def update(points, labels, centroids):
    sums = [[0.0] * 12 for _ in centroids]
    counts = [0] * len(centroids)
    for p, label in zip(points, labels):
        counts[label] += 1
        for m in range(12):
            sums[label][m] += p[m]
    return [[s / counts[j] for s in sums[j]] if counts[j] else list(centroids[j]) for j in range(len(centroids))]


def kmeans(points, k):
    centroids = maximin(points, k)
    labels = None
    for iteration in range(1, MAX_ITERATIONS + 1):
        new = assign(points, centroids)
        if new == labels:
            inertia = sum(distance(p, centroids[label]) for p, label in zip(points, labels))
            return labels, centroids, iteration - 1, inertia
        labels = new
        centroids = update(points, labels, centroids)
    raise ValueError("k-means did not converge")


def cluster(shares_by_index):
    """Return labels ordered so group 0 has the smallest January to April share."""
    points = [[v / SCALE for v in s] for s in shares_by_index]
    labels, centroids, iterations, inertia = kmeans(points, K)
    order = sorted(range(K), key=lambda j: sum(centroids[j][:4]))
    rank = {old: new for new, old in enumerate(order)}
    return [rank[label] for label in labels], [centroids[j] for j in order], iterations, inertia


if __name__ == "__main__":
    pts = [[1, 0] + [0] * 10, [0.9, 0.1] + [0] * 10, [0, 1] + [0] * 10, [0.1, 0.9] + [0] * 10]
    labels, _, _, _ = kmeans(pts, 2)
    assert labels[0] == labels[1] != labels[2] == labels[3], labels
    print("ok")
