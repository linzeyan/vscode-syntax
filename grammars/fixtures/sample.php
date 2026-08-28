<?php
declare(strict_types=1);

namespace App\Report;

use PDO;

/** text.html.php must switch between html, php, sql and js regions. */
final class ReleaseReport
{
    public function __construct(private readonly PDO $db) {}

    /** @return array<int, array{tag: string, assets: int}> */
    public function recent(int $limit = 10): array
    {
        $sql = <<<SQL
            SELECT tag, COUNT(asset_id) AS assets
            FROM releases JOIN assets USING (release_id)
            GROUP BY tag ORDER BY published_at DESC LIMIT :limit
        SQL;

        $stmt = $this->db->prepare($sql);
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->execute();

        return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    }
}

$report = new ReleaseReport(new PDO('sqlite::memory:'));
?>
<!doctype html>
<html lang="en">
  <body>
    <h1>Releases</h1>
    <ul>
      <?php foreach ($report->recent() as $row): ?>
        <li><?= htmlspecialchars($row['tag']) ?> — <?= (int) $row['assets'] ?> assets</li>
      <?php endforeach; ?>
    </ul>
    <script>
      document.querySelectorAll("li").forEach((el) => el.classList.add("row"));
    </script>
  </body>
</html>
