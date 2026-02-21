load("config.js");

function execute() {
  return Response.success([
    { title: "Lượt xem", input: "view_count", script: "homecontent.js" },
    { title: "Lượt đánh dấu", input: "bookmark_count", script: "homecontent.js" },
    { title: "Bình luận", input: "comment_count", script: "homecontent.js" },
    { title: "Đánh giá", input: "review_score", script: "homecontent.js" },
    { title: "Mới cập nhật", input: "updated_at", script: "homecontent.js" },
    { title: "Hoàn thành", input: "completed", script: "homecontent.js" }
  ]);
}
