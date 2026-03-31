import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { z } from "zod";
import { useSession } from "@/lib/auth-client";
import { client, unwrap, type Paginated } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Field, FieldLabel, FieldError, FieldGroup } from "@/components/ui/field";
import { Plus, Trash2, Edit, ChevronLeft, ChevronRight } from "lucide-react";

interface UserRow {
  id: string;
  name: string;
  email: string;
  username?: string | null;
  role?: string | null;
}

const createUserSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().min(1, "Email is required").email("Invalid email address"),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  role: z.string(),
});

const editUserSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().min(1, "Email is required").email("Invalid email address"),
  username: z.string().min(1, "Username is required"),
  role: z.string(),
});

export function UsersPage() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const isAdmin = session?.user?.role === "admin";
  const currentUserId = session?.user?.id;

  const [users, setUsers] = useState<UserRow[]>([]);
  const [usersTotal, setUsersTotal] = useState(0);
  const [usersPage, setUsersPage] = useState(1);
  const usersPerPage = 20;
  const [loading, setLoading] = useState(true);

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [deletingUser, setDeletingUser] = useState<UserRow | null>(null);
  const [saving, setSaving] = useState(false);

  const [createForm, setCreateForm] = useState({
    name: "",
    email: "",
    username: "",
    password: "",
    role: "user",
  });
  const [editForm, setEditForm] = useState({
    name: "",
    email: "",
    username: "",
    role: "user",
  });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!isAdmin && session) {
      navigate("/settings/profile", { replace: true });
      return;
    }
    client.api.settings.users
      .$get({ query: { page: String(usersPage), perPage: String(usersPerPage) } })
      .then((r) => unwrap<Paginated<UserRow>>(r))
      .then((result) => {
        setUsers(result.data);
        setUsersTotal(result.total);
      })
      .finally(() => setLoading(false));
  }, [isAdmin, session, navigate, usersPage]);

  const refresh = async () => {
    const res = await client.api.settings.users.$get({
      query: { page: String(usersPage), perPage: String(usersPerPage) },
    });
    const result = await unwrap<Paginated<UserRow>>(res);
    setUsers(result.data);
    setUsersTotal(result.total);
  };

  const openCreate = () => {
    setCreateForm({ name: "", email: "", username: "", password: "", role: "user" });
    setFormErrors({});
    setCreateDialogOpen(true);
  };

  const openEdit = (u: UserRow) => {
    setEditingUser(u);
    setEditForm({
      name: u.name,
      email: u.email,
      username: u.username || "",
      role: u.role || "user",
    });
    setFormErrors({});
    setEditDialogOpen(true);
  };

  const handleCreate = async () => {
    setFormErrors({});
    const result = createUserSchema.safeParse(createForm);
    if (!result.success) {
      const errs: Record<string, string> = {};
      for (const issue of result.error.issues) errs[issue.path[0] as string] = issue.message;
      setFormErrors(errs);
      return;
    }
    setSaving(true);
    try {
      await client.api.settings.users.$post({
        json: {
          name: result.data.name.trim(),
          email: result.data.email.trim(),
          username: result.data.username.trim(),
          password: result.data.password,
          role: result.data.role,
        },
      });
      setCreateDialogOpen(false);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async () => {
    if (!editingUser) return;
    setFormErrors({});
    const result = editUserSchema.safeParse(editForm);
    if (!result.success) {
      const errs: Record<string, string> = {};
      for (const issue of result.error.issues) errs[issue.path[0] as string] = issue.message;
      setFormErrors(errs);
      return;
    }
    setSaving(true);
    try {
      await client.api.settings.users[":id"].$put({
        param: { id: editingUser.id },
        json: {
          name: result.data.name.trim(),
          email: result.data.email.trim(),
          username: result.data.username.trim(),
          role: result.data.role,
        },
      });
      setEditDialogOpen(false);
      setEditingUser(null);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingUser) return;
    await client.api.settings.users[":id"].$delete({ param: { id: deletingUser.id } });
    setDeleteDialogOpen(false);
    setDeletingUser(null);
    await refresh();
  };

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading users...</div>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            Users
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-3" />
              Add User
            </Button>
          </CardTitle>
          <CardDescription>
            Manage platform users and their roles. Only admins can access this page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden sm:table-cell">Email</TableHead>
                <TableHead className="hidden sm:table-cell">Username</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => {
                const isSelf = u.id === currentUserId;
                return (
                  <TableRow key={u.id}>
                    <TableCell>{u.name}</TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {u.email}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {u.username || "\u2014"}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={u.role || "user"}
                        onValueChange={(val) => {
                          if (val !== null && !isSelf) {
                            client.api.settings.users[":id"].role
                              .$put({ param: { id: u.id }, json: { role: val } })
                              .then(() => refresh());
                          }
                        }}
                        items={[
                          { label: "User", value: "user" },
                          { label: "Admin", value: "admin" },
                        ]}
                      >
                        <SelectTrigger className="h-6 w-24" disabled={isSelf}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="user">User</SelectItem>
                          <SelectItem value="admin">Admin</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon-sm" onClick={() => openEdit(u)}>
                          <Edit className="size-3" />
                        </Button>
                        {!isSelf && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => {
                              setDeletingUser(u);
                              setDeleteDialogOpen(true);
                            }}
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {Math.ceil(usersTotal / usersPerPage) > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={usersPage <= 1}
            onClick={() => setUsersPage((p) => p - 1)}
          >
            <ChevronLeft className="size-3" /> Prev
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {usersPage} of {Math.ceil(usersTotal / usersPerPage)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={usersPage >= Math.ceil(usersTotal / usersPerPage)}
            onClick={() => setUsersPage((p) => p + 1)}
          >
            Next <ChevronRight className="size-3" />
          </Button>
        </div>
      )}

      {/* Create User Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add User</DialogTitle>
            <DialogDescription>Create a new platform user.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!formErrors.name || undefined}>
              <FieldLabel>Name</FieldLabel>
              <Input
                value={createForm.name}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, name: e.target.value }))}
              />
              {formErrors.name && <FieldError errors={[{ message: formErrors.name }]} />}
            </Field>
            <Field data-invalid={!!formErrors.email || undefined}>
              <FieldLabel>Email</FieldLabel>
              <Input
                type="email"
                value={createForm.email}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, email: e.target.value }))}
              />
              {formErrors.email && <FieldError errors={[{ message: formErrors.email }]} />}
            </Field>
            <Field data-invalid={!!formErrors.username || undefined}>
              <FieldLabel>Username</FieldLabel>
              <Input
                value={createForm.username}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, username: e.target.value }))}
              />
              {formErrors.username && <FieldError errors={[{ message: formErrors.username }]} />}
            </Field>
            <Field data-invalid={!!formErrors.password || undefined}>
              <FieldLabel>Password</FieldLabel>
              <Input
                type="password"
                value={createForm.password}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, password: e.target.value }))}
              />
              {formErrors.password && <FieldError errors={[{ message: formErrors.password }]} />}
            </Field>
            <Field>
              <FieldLabel>Role</FieldLabel>
              <Select
                value={createForm.role}
                onValueChange={(v) => v !== null && setCreateForm((prev) => ({ ...prev, role: v }))}
                items={[
                  { label: "User", value: "user" },
                  { label: "Admin", value: "admin" },
                ]}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button onClick={handleCreate} disabled={saving}>
              {saving ? "Creating..." : "Create User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>Update user details.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!formErrors.name || undefined}>
              <FieldLabel>Name</FieldLabel>
              <Input
                value={editForm.name}
                onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
              />
              {formErrors.name && <FieldError errors={[{ message: formErrors.name }]} />}
            </Field>
            <Field data-invalid={!!formErrors.email || undefined}>
              <FieldLabel>Email</FieldLabel>
              <Input
                type="email"
                value={editForm.email}
                onChange={(e) => setEditForm((prev) => ({ ...prev, email: e.target.value }))}
              />
              {formErrors.email && <FieldError errors={[{ message: formErrors.email }]} />}
            </Field>
            <Field data-invalid={!!formErrors.username || undefined}>
              <FieldLabel>Username</FieldLabel>
              <Input
                value={editForm.username}
                onChange={(e) => setEditForm((prev) => ({ ...prev, username: e.target.value }))}
              />
              {formErrors.username && <FieldError errors={[{ message: formErrors.username }]} />}
            </Field>
            {editingUser?.id !== currentUserId && (
              <Field>
                <FieldLabel>Role</FieldLabel>
                <Select
                  value={editForm.role}
                  onValueChange={(v) => v !== null && setEditForm((prev) => ({ ...prev, role: v }))}
                  items={[
                    { label: "User", value: "user" },
                    { label: "Admin", value: "admin" },
                  ]}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">User</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}
          </FieldGroup>
          <DialogFooter>
            <Button onClick={handleEdit} disabled={saving}>
              {saving ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete User</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deletingUser?.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
